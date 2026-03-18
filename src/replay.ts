import type { Message, Part } from "@opencode-ai/sdk"
import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2/client"

import { classifyWithSmallModel } from "./classifier.js"
import { buildClassifierPayload, detectTruncation, type DetectorToolOutcome } from "./detector.js"
import { escalateToUserJudgment, type JudgmentEscalationReason } from "./escalation.js"
import { assessSideEffects } from "./side-effects.js"
import type { SessionTracker } from "./tracker.js"
import { ClassifierResult, type PluginConfig, type ReplayEnvelope, type ReplayFormat, type ReplayModel } from "./types.js"

export type SessionMessageHistory = Array<{
  info: Message
  parts: Part[]
}>

export const RECENT_MESSAGE_PAGE_SIZE = 8

interface SessionMessagesQuery {
  limit?: number
  before?: string
}

export interface ReplayTransactionClient {
  session?: {
    messages?: (parameters: { path: { id: string }; query?: SessionMessagesQuery }) => Promise<{ data?: unknown }>
    status?: () => Promise<{ data?: unknown }>
    revert?: (parameters: { path: { id: string }; body: { messageID: string; partID?: string } }) => Promise<unknown>
    unrevert?: (parameters: { path: { id: string } }) => Promise<unknown>
  }
  tui?: {
    appendPrompt?: (parameters: {
      body?: {
        text: string
      }
    }) => Promise<unknown>
    showToast?: (parameters: {
      body?: {
        title?: string
        message: string
        variant: "info" | "success" | "warning" | "error"
        duration?: number
      }
    }) => Promise<unknown>
  }
}

export interface ReplaySubmissionRequest {
  sessionID: string
  directory?: string
  workspace?: string
  messageID?: string
  model?: ReplayModel
  agent?: string
  format?: ReplayFormat
  system?: string
  variant?: string
  parts?: unknown[]
}

export interface ReplaySubmissionClient {
  session?: {
    prompt?: (parameters: ReplaySubmissionRequest) => Promise<unknown>
  }
}

export interface ReplaySubmissionClientFactoryInput {
  directory: string
  serverUrl: URL
}

export type ReplaySubmissionClientFactory = (input: ReplaySubmissionClientFactoryInput) => ReplaySubmissionClient

export interface AttemptSafeReplayTransactionInput {
  client: ReplayTransactionClient
  tracker: SessionTracker
  config: PluginConfig
  sessionID: string
  generation: number
  prefetchedMessages?: SessionMessageHistory
  recentToolOutcomes?: readonly DetectorToolOutcome[]
  directory?: string
  serverUrl?: URL
  replayClientFactory?: ReplaySubmissionClientFactory
}

export type ReplayIgnoredReason =
  | "already-escalated"
  | "assistant-aborted"
  | "assistant-api-error"
  | "assistant-auth-error"
  | "assistant-context-overflow"
  | "assistant-error"
  | "busy-session"
  | "client-read-failed"
  | "missing-assistant-message"
  | "missing-session"
  | "normal-turn"
  | "structured-output-complete"
  | "structured-output-error"
  | "stale-generation"

export type ReplayEscalationReason = JudgmentEscalationReason

export type ReplayTransactionResult =
  | { outcome: "ignored"; reason: ReplayIgnoredReason }
  | { outcome: "replayed"; retryCount: number }
  | { outcome: "escalated"; reason: ReplayEscalationReason }

interface AssistantMessageLike {
  role?: string
  finish?: string
  error?: unknown
  structured?: unknown
}

interface SessionStatusLike {
  type?: string
}

type FinishErrorIgnoredReason =
  | "assistant-aborted"
  | "assistant-api-error"
  | "assistant-auth-error"
  | "assistant-context-overflow"
  | "assistant-error"

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function isActiveSessionStatus(status: SessionStatusLike | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry"
}

function isBusySessionError(error: unknown, sessionID: string): boolean {
  const message = normalizeOptionalString(asRecord(error)?.message)
  return message === `Session ${sessionID} is busy`
}

function isAssistantMessage(info: unknown): info is AssistantMessageLike {
  return asRecord(info)?.role === "assistant"
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return part.type === "text"
}

function isStepFinishPart(part: Part): part is Extract<Part, { type: "step-finish" }> {
  return part.type === "step-finish"
}

function getLastAssistantMessage(messages: readonly SessionMessageHistory[number][]): SessionMessageHistory[number] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isAssistantMessage(message.info)) {
      return message
    }
  }

  return undefined
}

function getAssistantText(parts: readonly Part[]): string {
  return parts
    .filter(isTextPart)
    .filter((part) => !part.ignored)
    .map((part) => part.text ?? "")
    .join("")
}

function hasStructuredOutputResult(message: SessionMessageHistory[number]): boolean {
  const info = asRecord(message.info)
  return Boolean(info && Object.prototype.hasOwnProperty.call(info, "structured") && info.structured !== undefined)
}

function isStructuredOutputError(error: unknown): boolean {
  return normalizeOptionalString(asRecord(error)?.name) === "StructuredOutputError"
}

function getFinishErrorIgnoredReason(error: unknown): FinishErrorIgnoredReason {
  const name = normalizeOptionalString(asRecord(error)?.name)

  switch (name) {
    case "MessageAbortedError":
      return "assistant-aborted"
    case "ProviderAuthError":
      return "assistant-auth-error"
    case "ContextOverflowError":
      return "assistant-context-overflow"
    case "APIError":
      return "assistant-api-error"
    default:
      return "assistant-error"
  }
}

function getFinishReason(message: SessionMessageHistory[number]): string | undefined {
  const info = message.info as AssistantMessageLike
  if (normalizeOptionalString(info.finish)) {
    return info.finish
  }

  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]
    if (isStepFinishPart(part)) {
      return normalizeOptionalString(part.reason)
    }
  }

  return undefined
}

function getSessionStatusForID(data: unknown, sessionID: string): SessionStatusLike | undefined {
  const record = asRecord(data)
  const status = record?.[sessionID]
  return asRecord(status) as SessionStatusLike | undefined
}

function toReplayModel(model: ReplayEnvelope["model"]): ReplayModel | undefined {
  const record = asRecord(model)
  const providerID = normalizeOptionalString(record?.providerID)
  const modelID = normalizeOptionalString(record?.modelID)

  if (!providerID || !modelID) {
    return undefined
  }

  return {
    providerID,
    modelID,
  }
}

function toReplayFormat(format: ReplayEnvelope["format"]): ReplayFormat | undefined {
  const record = asRecord(format)
  const type = normalizeOptionalString(record?.type)

  if (!type) {
    return undefined
  }

  return cloneValue(record as ReplayFormat)
}

async function rollbackRevert(client: ReplayTransactionClient, sessionID: string): Promise<void> {
  await client.session?.unrevert?.({ path: { id: sessionID } })
}

interface TurnReplayDisposition {
  action: "escalate" | "ignore" | "retry"
  reason?: ReplayEscalationReason | ReplayIgnoredReason
}

async function getCurrentStatus(client: ReplayTransactionClient, sessionID: string): Promise<SessionStatusLike | undefined> {
  const response = await client.session?.status?.()
  return getSessionStatusForID(response?.data, sessionID)
}

async function handleRevertFailureForReplay(input: {
  client: ReplayTransactionClient
  tracker: SessionTracker
  sessionID: string
  generation: number
  error: unknown
}): Promise<ReplayTransactionResult> {
  const current = input.tracker.getSession(input.sessionID)
  if (!current) {
    return { outcome: "ignored", reason: "missing-session" }
  }

  if (current.generation !== input.generation) {
    return { outcome: "ignored", reason: "stale-generation" }
  }

  const statusAfterFailure = await getCurrentStatus(input.client, input.sessionID).catch(() => undefined)
  if (isBusySessionError(input.error, input.sessionID) || isActiveSessionStatus(statusAfterFailure)) {
    input.tracker.clearPendingIdleForGeneration({
      sessionID: input.sessionID,
      generation: input.generation,
    })
    return { outcome: "ignored", reason: "busy-session" }
  }

  await escalateToUserJudgment({
    client: input.client,
    tracker: input.tracker,
    sessionID: input.sessionID,
    generation: input.generation,
    reason: "replay-revert-failed",
  })
  return { outcome: "escalated", reason: "replay-revert-failed" }
}

export async function listSessionMessages(
  client: ReplayTransactionClient,
  sessionID: string,
  options: SessionMessagesQuery = {},
): Promise<SessionMessageHistory> {
  const response = await client.session?.messages?.({
    path: { id: sessionID },
    ...(Object.keys(options).length > 0 ? { query: options } : {}),
  })
  return cloneValue((response?.data ?? []) as SessionMessageHistory)
}

async function listReplayCandidateMessages(
  client: ReplayTransactionClient,
  sessionID: string,
): Promise<SessionMessageHistory> {
  const recentMessages = await listSessionMessages(client, sessionID, { limit: RECENT_MESSAGE_PAGE_SIZE })
  if (getLastAssistantMessage(recentMessages) || recentMessages.length < RECENT_MESSAGE_PAGE_SIZE) {
    return recentMessages
  }

  return listSessionMessages(client, sessionID)
}

export const createDefaultReplayClientFactory: ReplaySubmissionClientFactory = ({ directory, serverUrl }) => {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"

  return createV2OpencodeClient({
    baseUrl: serverUrl.toString(),
    directory,
    headers: password
      ? {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        }
      : undefined,
  }) as unknown as ReplaySubmissionClient
}

async function classifyTurnForReplay(input: {
  config: PluginConfig
  replayEnvelope: ReplayEnvelope
  lastAssistantMessage: SessionMessageHistory[number]
  recentToolOutcomes?: readonly DetectorToolOutcome[]
  retryCount: number
}): Promise<TurnReplayDisposition> {
  if (hasStructuredOutputResult(input.lastAssistantMessage)) {
    return { action: "ignore", reason: "structured-output-complete" }
  }

  const finishError = (input.lastAssistantMessage.info as AssistantMessageLike).error
  if (isStructuredOutputError(finishError)) {
    return { action: "ignore", reason: "structured-output-error" }
  }

  const sideEffects = assessSideEffects({
    completedTools: input.recentToolOutcomes?.map((outcome) => ({ tool: outcome.toolName, args: outcome.toolArgs })),
    parts: input.lastAssistantMessage.parts,
  })
  if (sideEffects.blocksAutoRetry) {
    return { action: "escalate", reason: "unsafe-turn" }
  }

  const lastAssistantText = getAssistantText(input.lastAssistantMessage.parts)
  const finishReason = getFinishReason(input.lastAssistantMessage)
  const detection = detectTruncation({
    lastAssistantText,
    finishReason,
    finishError,
  })

  if (detection.decision === ClassifierResult.NORMAL) {
    return { action: "ignore", reason: "normal-turn" }
  }

  if (detection.decision === ClassifierResult.TRUNCATED) {
    return { action: "retry" }
  }

  if (finishError) {
    return {
      action: "ignore",
      reason: getFinishErrorIgnoredReason(finishError),
    }
  }

  const classifier = await classifyWithSmallModel({
    config: input.config,
    payload: buildClassifierPayload({
      replayEnvelope: input.replayEnvelope,
      lastAssistantText,
      finishReason: detection.finishReason,
      finishError: detection.finishError,
      recentToolOutcomes: input.recentToolOutcomes,
      retryCount: input.retryCount,
    }),
  })

  if (classifier.result === ClassifierResult.NORMAL) {
    return { action: "ignore", reason: "normal-turn" }
  }

  if (classifier.result === ClassifierResult.TRUNCATED) {
    return { action: "retry" }
  }

  return {
    action: "escalate",
    reason: "maybe-truncated-needs-judgment",
  }
}

export async function attemptSafeReplayTransaction(
  input: AttemptSafeReplayTransactionInput,
): Promise<ReplayTransactionResult> {
  const currentBeforeRead = input.tracker.getSession(input.sessionID)

  if (!currentBeforeRead) {
    return { outcome: "ignored", reason: "missing-session" }
  }

  if (currentBeforeRead.generation !== input.generation) {
    return { outcome: "ignored", reason: "stale-generation" }
  }

  if (currentBeforeRead.isEscalated) {
    return { outcome: "ignored", reason: "already-escalated" }
  }

  let statusBeforeRead: SessionStatusLike | undefined
  let messages: SessionMessageHistory

  try {
    statusBeforeRead = await getCurrentStatus(input.client, input.sessionID)
    if (isActiveSessionStatus(statusBeforeRead)) {
      input.tracker.clearPendingIdleForGeneration({ sessionID: input.sessionID, generation: input.generation })
      return { outcome: "ignored", reason: "busy-session" }
    }

    messages = input.prefetchedMessages
      ? cloneValue(input.prefetchedMessages)
      : await listReplayCandidateMessages(input.client, input.sessionID)
  } catch {
    input.tracker.clearPendingIdleForGeneration({ sessionID: input.sessionID, generation: input.generation })
    return { outcome: "ignored", reason: "client-read-failed" }
  }

  const currentAfterRead = input.tracker.getSession(input.sessionID)
  if (!currentAfterRead) {
    return { outcome: "ignored", reason: "missing-session" }
  }

  if (currentAfterRead.generation !== input.generation) {
    return { outcome: "ignored", reason: "stale-generation" }
  }

  if (currentAfterRead.isEscalated) {
    return { outcome: "ignored", reason: "already-escalated" }
  }

  const replayEnvelope = currentAfterRead.replayEnvelope
  if (!replayEnvelope || !currentAfterRead.rootMessageID) {
    await escalateToUserJudgment({
      client: input.client,
      tracker: input.tracker,
      sessionID: input.sessionID,
      generation: input.generation,
      reason: "missing-replay-envelope",
    })
    return { outcome: "escalated", reason: "missing-replay-envelope" }
  }

  const lastAssistantMessage = getLastAssistantMessage(messages)
  if (!lastAssistantMessage) {
    input.tracker.clearPendingIdleForGeneration({ sessionID: input.sessionID, generation: input.generation })
    return { outcome: "ignored", reason: "missing-assistant-message" }
  }

  const turnDisposition = await classifyTurnForReplay({
    config: input.config,
    replayEnvelope,
    lastAssistantMessage,
    recentToolOutcomes: input.recentToolOutcomes,
    retryCount: currentAfterRead.retryCount,
  })

  if (turnDisposition.action === "ignore") {
    return {
      outcome: "ignored",
      reason: (turnDisposition.reason ?? "normal-turn") as ReplayIgnoredReason,
    }
  }

  if (turnDisposition.action === "escalate") {
    await escalateToUserJudgment({
      client: input.client,
      tracker: input.tracker,
      sessionID: input.sessionID,
      generation: input.generation,
      reason: turnDisposition.reason as ReplayEscalationReason,
    })
    return {
      outcome: "escalated",
      reason: turnDisposition.reason as ReplayEscalationReason,
    }
  }

  if (!input.tracker.canRetry({
    sessionID: input.sessionID,
    generation: input.generation,
    maxRetries: input.config.maxRetries,
  })) {
    await escalateToUserJudgment({
      client: input.client,
      tracker: input.tracker,
      sessionID: input.sessionID,
      generation: input.generation,
      reason: "retry-budget-exhausted",
    })
    return { outcome: "escalated", reason: "retry-budget-exhausted" }
  }

  if (!input.directory || !input.serverUrl) {
    await escalateToUserJudgment({
      client: input.client,
      tracker: input.tracker,
      sessionID: input.sessionID,
      generation: input.generation,
      reason: "replay-bootstrap-failed",
    })
    return { outcome: "escalated", reason: "replay-bootstrap-failed" }
  }

  let replayClient: ReplaySubmissionClient
  try {
    replayClient = (input.replayClientFactory ?? createDefaultReplayClientFactory)({
      directory: input.directory,
      serverUrl: input.serverUrl,
    })
  } catch {
    await escalateToUserJudgment({
      client: input.client,
      tracker: input.tracker,
      sessionID: input.sessionID,
      generation: input.generation,
      reason: "replay-bootstrap-failed",
    })
    return { outcome: "escalated", reason: "replay-bootstrap-failed" }
  }

  if (typeof replayClient.session?.prompt !== "function") {
    await escalateToUserJudgment({
      client: input.client,
      tracker: input.tracker,
      sessionID: input.sessionID,
      generation: input.generation,
      reason: "replay-bootstrap-failed",
    })
    return { outcome: "escalated", reason: "replay-bootstrap-failed" }
  }

  const statusBeforeRevert = await getCurrentStatus(input.client, input.sessionID).catch(() => undefined)
  if (isActiveSessionStatus(statusBeforeRevert)) {
    input.tracker.clearPendingIdleForGeneration({ sessionID: input.sessionID, generation: input.generation })
    return { outcome: "ignored", reason: "busy-session" }
  }

  const currentBeforeRevert = input.tracker.getSession(input.sessionID)
  if (!currentBeforeRevert) {
    return { outcome: "ignored", reason: "missing-session" }
  }

  if (currentBeforeRevert.generation !== input.generation) {
    return { outcome: "ignored", reason: "stale-generation" }
  }

  try {
    await input.client.session?.revert?.({
      path: { id: input.sessionID },
      body: { messageID: replayEnvelope.rootMessageID },
    })
  } catch (error) {
    return handleRevertFailureForReplay({
      client: input.client,
      tracker: input.tracker,
      sessionID: input.sessionID,
      generation: input.generation,
      error,
    })
  }

  const currentBeforeReplay = input.tracker.getSession(input.sessionID)
  if (!currentBeforeReplay || currentBeforeReplay.generation !== input.generation) {
    await rollbackRevert(input.client, input.sessionID).catch(() => undefined)
    return { outcome: "ignored", reason: "stale-generation" }
  }

  const statusBeforeReplay = await getCurrentStatus(input.client, input.sessionID).catch(() => undefined)
  if (isActiveSessionStatus(statusBeforeReplay)) {
    await rollbackRevert(input.client, input.sessionID).catch(() => undefined)
    input.tracker.clearPendingIdleForGeneration({ sessionID: input.sessionID, generation: input.generation })
    return { outcome: "ignored", reason: "busy-session" }
  }

  const recordedRetry = input.tracker.recordRetry({
    sessionID: input.sessionID,
    generation: input.generation,
    maxRetries: input.config.maxRetries,
  })
  if (!recordedRetry.recorded) {
    await rollbackRevert(input.client, input.sessionID).catch(() => undefined)
    if (recordedRetry.reason === "retry-limit-reached") {
      await escalateToUserJudgment({
        client: input.client,
        tracker: input.tracker,
        sessionID: input.sessionID,
        generation: input.generation,
        reason: "retry-budget-exhausted",
      })
      return { outcome: "escalated", reason: "retry-budget-exhausted" }
    }

    return {
      outcome: "ignored",
      reason: recordedRetry.reason === "stale-generation" ? "stale-generation" : "missing-session",
    }
  }

  try {
    await replayClient.session.prompt({
      sessionID: input.sessionID,
      directory: input.directory,
      messageID: replayEnvelope.rootMessageID,
      parts: cloneValue(replayEnvelope.parts),
      agent: replayEnvelope.agent,
      model: toReplayModel(replayEnvelope.model),
      system: replayEnvelope.system,
      format: toReplayFormat(replayEnvelope.format),
      variant: replayEnvelope.variant,
    })
  } catch {
    let rollbackSucceeded = true
    try {
      await rollbackRevert(input.client, input.sessionID)
    } catch {
      rollbackSucceeded = false
    }

    const escalationReason: ReplayEscalationReason = rollbackSucceeded ? "replay-submit-failed" : "replay-rollback-failed"
    await escalateToUserJudgment({
      client: input.client,
      tracker: input.tracker,
      sessionID: input.sessionID,
      generation: input.generation,
      reason: escalationReason,
    })
    return { outcome: "escalated", reason: escalationReason }
  }

  return {
    outcome: "replayed",
    retryCount: recordedRetry.snapshot?.retryCount ?? currentBeforeReplay.retryCount + 1,
  }
}
