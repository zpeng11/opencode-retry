import type { SessionTracker } from "./tracker.js"

export type JudgmentEscalationReason =
  | "classifier-truncated"
  | "maybe-truncated-needs-judgment"
  | "missing-replay-envelope"
  | "replay-bootstrap-failed"
  | "replay-submit-failed"
  | "replay-rollback-failed"
  | "retry-budget-exhausted"
  | "unsafe-turn"

export interface EscalationClient {
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

interface EscalationCopy {
  promptText: string
  toastMessage: string
}

const ESCALATION_PROMPT =
  "Review the previous turn, then retry only if it is safe. It may have been truncated or may already have caused side effects."

function getEscalationCopy(reason: JudgmentEscalationReason): EscalationCopy {
  switch (reason) {
    case "unsafe-turn":
      return {
        promptText: ESCALATION_PROMPT,
        toastMessage: "Previous turn may already have caused side effects.",
      }
    case "classifier-truncated":
      return {
        promptText: ESCALATION_PROMPT,
        toastMessage: "Previous turn may have been truncated.",
      }
    case "maybe-truncated-needs-judgment":
      return {
        promptText: ESCALATION_PROMPT,
        toastMessage: "Possible truncation needs your review.",
      }
    case "retry-budget-exhausted":
      return {
        promptText: ESCALATION_PROMPT,
        toastMessage: "Automatic retries stopped. Review the previous turn.",
      }
    case "replay-submit-failed":
      return {
        promptText: ESCALATION_PROMPT,
        toastMessage: "Automatic retry failed. Session restored.",
      }
    case "replay-rollback-failed":
      return {
        promptText: ESCALATION_PROMPT,
        toastMessage: "Retry failed. Unable to restore session. Review the state carefully.",
      }
    case "replay-bootstrap-failed":
      return {
        promptText: ESCALATION_PROMPT,
        toastMessage: "Automatic retry stopped.",
      }
    case "missing-replay-envelope":
      return {
        promptText: ESCALATION_PROMPT,
        toastMessage: "Automatic retry stopped. Review the previous turn.",
      }
  }
}

export async function escalateToUserJudgment(input: {
  client: EscalationClient
  tracker: SessionTracker
  sessionID: string
  generation: number
  reason: JudgmentEscalationReason
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

  const copy = getEscalationCopy(input.reason)

  await Promise.allSettled([
    input.client.tui?.showToast?.({
      body: {
        title: "Retry stopped",
        message: copy.toastMessage,
        variant: "warning",
        duration: 4000,
      },
    }),
    input.client.tui?.appendPrompt?.({
      body: {
        text: copy.promptText,
      },
    }),
  ])
}
