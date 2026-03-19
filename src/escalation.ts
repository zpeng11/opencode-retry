import type { Message, Part } from "@opencode-ai/sdk"

import { createAuthenticatedServerClient, type ServerClientFactoryInput } from "./server-client.js"
import type { SessionTracker } from "./tracker.js"

export type JudgmentEscalationReason =
  | "classifier-truncated"
  | "maybe-truncated-needs-judgment"
  | "missing-replay-envelope"
  | "replay-bootstrap-failed"
  | "replay-revert-failed"
  | "replay-submit-failed"
  | "replay-rollback-failed"
  | "retry-budget-exhausted"
  | "unsafe-turn"

const ALL_ESCALATION_REASONS: JudgmentEscalationReason[] = [
  "unsafe-turn",
  "classifier-truncated",
  "maybe-truncated-needs-judgment",
  "retry-budget-exhausted",
  "replay-revert-failed",
  "replay-submit-failed",
  "replay-rollback-failed",
  "replay-bootstrap-failed",
  "missing-replay-envelope",
]

const ESCALATION_WARNING_METADATA_KEY = "opencodeRetryEscalationWarningReason"

export const ESCALATION_REVIEW_INSTRUCTION =
  "Review the previous turn before retrying. It may have been truncated or may already have caused side effects."

type SessionMessageHistory = Array<{
  info: Message
  parts: Part[]
}>

export interface EscalationClient {
  session?: {
    messages?: (parameters: {
      path: {
        id: string
      }
    }) => Promise<{ data?: unknown }>
  }
}

export interface EscalationWarningClient {
  part?: {
    update?: (parameters: {
      sessionID: string
      messageID: string
      partID: string
      directory?: string
      part?: unknown
    }) => Promise<unknown>
  }
}

export type EscalationWarningClientFactory = (input: ServerClientFactoryInput) => EscalationWarningClient

interface EscalationCopy {
  toastMessage: string
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function isJudgmentEscalationReason(value: unknown): value is JudgmentEscalationReason {
  return typeof value === "string" && ALL_ESCALATION_REASONS.includes(value as JudgmentEscalationReason)
}

function isAssistantMessage(info: Message): boolean {
  return info.role === "assistant"
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return part.type === "text"
}

function getEscalationCopy(reason: JudgmentEscalationReason): EscalationCopy {
  switch (reason) {
    case "unsafe-turn":
      return {
        toastMessage: "Previous turn may already have caused side effects.",
      }
    case "classifier-truncated":
      return {
        toastMessage: "Previous turn may have been truncated.",
      }
    case "maybe-truncated-needs-judgment":
      return {
        toastMessage: "Possible truncation needs your review.",
      }
    case "retry-budget-exhausted":
      return {
        toastMessage: "Automatic retries stopped. Review the previous turn.",
      }
    case "replay-revert-failed":
      return {
        toastMessage: "Automatic retry failed while reverting the previous turn. Review the session state carefully.",
      }
    case "replay-submit-failed":
      return {
        toastMessage: "Automatic retry failed. Session restored.",
      }
    case "replay-rollback-failed":
      return {
        toastMessage: "Retry failed. Unable to restore session. Review the state carefully.",
      }
    case "replay-bootstrap-failed":
      return {
        toastMessage: "Automatic retry stopped.",
      }
    case "missing-replay-envelope":
      return {
        toastMessage: "Automatic retry stopped. Review the previous turn.",
      }
  }
}

function buildEscalationWarningBody(reason: JudgmentEscalationReason): string {
  const copy = getEscalationCopy(reason)

  return [
    `Warning: ${copy.toastMessage}`,
    "This note is shown by opencode-retry and is not sent back to the agent.",
    ESCALATION_REVIEW_INSTRUCTION,
  ].join("\n")
}

function buildEscalationAssistantWarningSuffix(reason: JudgmentEscalationReason): string {
  return `\n\n${buildEscalationWarningBody(reason)}`
}

function stripAllEscalationAssistantWarnings(text: string): string {
  let stripped = text

  for (const reason of ALL_ESCALATION_REASONS) {
    const suffix = buildEscalationAssistantWarningSuffix(reason)
    if (stripped.endsWith(suffix)) {
      stripped = stripped.slice(0, -suffix.length)
    }
  }

  return stripped
}

export function appendEscalationWarningToAssistantText(text: string, reason: JudgmentEscalationReason): string {
  const base = stripAllEscalationAssistantWarnings(text).trimEnd()
  const warning = buildEscalationWarningBody(reason)

  return base ? `${base}\n\n${warning}` : warning
}

export function stripEscalationWarningFromAssistantText(text: string, metadata: unknown): string {
  const reason = asRecord(metadata)?.[ESCALATION_WARNING_METADATA_KEY]
  if (!isJudgmentEscalationReason(reason)) {
    return text
  }

  const suffix = buildEscalationAssistantWarningSuffix(reason)
  if (!text.endsWith(suffix)) {
    return text
  }

  return text.slice(0, -suffix.length).trimEnd()
}

export const createDefaultEscalationWarningClientFactory: EscalationWarningClientFactory = (input) =>
  createAuthenticatedServerClient(input) as unknown as EscalationWarningClient

async function listSessionMessages(client: EscalationClient, sessionID: string): Promise<SessionMessageHistory> {
  const response = await client.session?.messages?.({
    path: { id: sessionID },
  })

  return cloneValue((response?.data ?? []) as SessionMessageHistory)
}

function getLastAssistantTextTarget(messages: readonly SessionMessageHistory[number][]) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!isAssistantMessage(message.info)) {
      continue
    }

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]
      if (!isTextPart(part)) {
        continue
      }

      return {
        messageID: message.info.id,
        part,
      }
    }
  }
}

async function appendWarningToTranscript(input: {
  client: EscalationClient
  sessionID: string
  reason: JudgmentEscalationReason
  directory?: string
  serverUrl?: URL
  messages?: SessionMessageHistory
  warningClientFactory?: EscalationWarningClientFactory
}): Promise<boolean> {
  if (!input.directory || !input.serverUrl) {
    return false
  }

  const messages = input.messages ?? (await listSessionMessages(input.client, input.sessionID))
  const target = getLastAssistantTextTarget(messages)

  if (!target) {
    return false
  }

  const warningClient = (input.warningClientFactory ?? createDefaultEscalationWarningClientFactory)({
    directory: input.directory,
    serverUrl: input.serverUrl,
  })

  if (typeof warningClient.part?.update !== "function") {
    return false
  }

  const metadata = asRecord(target.part.metadata)

  await warningClient.part.update({
    sessionID: input.sessionID,
    messageID: target.messageID,
    partID: target.part.id,
    directory: input.directory,
    part: {
      ...cloneValue(target.part),
      text: appendEscalationWarningToAssistantText(target.part.text ?? "", input.reason),
      metadata: {
        ...(metadata ? cloneValue(metadata) : {}),
        [ESCALATION_WARNING_METADATA_KEY]: input.reason,
      },
    },
  })

  return true
}

export async function escalateToUserJudgment(input: {
  client: EscalationClient
  tracker: SessionTracker
  sessionID: string
  generation: number
  reason: JudgmentEscalationReason
  directory?: string
  serverUrl?: URL
  messages?: SessionMessageHistory
  warningClientFactory?: EscalationWarningClientFactory
}): Promise<void> {
  const current = input.tracker.getSession(input.sessionID)

  if (!current || current.generation !== input.generation || current.isEscalated) {
    return
  }

  const marked = input.tracker.markEscalated({
    sessionID: input.sessionID,
    generation: input.generation,
  })

  if (!marked.updated) {
    return
  }

  const warningWritten = await appendWarningToTranscript(input).catch(() => false)
  if (!warningWritten) {
    return
  }
}
