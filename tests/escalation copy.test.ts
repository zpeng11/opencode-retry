import { describe, expect, test } from "bun:test"

import { escalateToUserJudgment, type JudgmentEscalationReason } from "../src/escalation.js"
import { createSessionTracker } from "../src/tracker.js"
import type { ReplayEnvelope } from "../src/types.js"

const ESCALATION_PROMPT =
  "Review the previous turn, then retry only if it is safe. It may have been truncated or may already have caused side effects."

function createReplayEnvelope(sessionID: string, rootMessageID: string): ReplayEnvelope {
  return {
    sessionID,
    rootMessageID,
    parts: [{ type: "text", text: "Retry safely." }],
  }
}

describe("escalation copy", () => {
  test("maps each escalation reason to the expected TUI notification", async () => {
    const cases: Array<{ reason: JudgmentEscalationReason; toastMessage: string }> = [
      {
        reason: "unsafe-turn",
        toastMessage: "Previous turn may already have caused side effects.",
      },
      {
        reason: "classifier-truncated",
        toastMessage: "Previous turn may have been truncated.",
      },
      {
        reason: "maybe-truncated-needs-judgment",
        toastMessage: "Possible truncation needs your review.",
      },
      {
        reason: "retry-budget-exhausted",
        toastMessage: "Automatic retries stopped. Review the previous turn.",
      },
      {
        reason: "replay-revert-failed",
        toastMessage: "Automatic retry failed while reverting the previous turn. Review the session state carefully.",
      },
      {
        reason: "replay-submit-failed",
        toastMessage: "Automatic retry failed. Session restored.",
      },
      {
        reason: "replay-rollback-failed",
        toastMessage: "Retry failed. Unable to restore session. Review the state carefully.",
      },
      {
        reason: "replay-bootstrap-failed",
        toastMessage: "Automatic retry stopped.",
      },
      {
        reason: "missing-replay-envelope",
        toastMessage: "Automatic retry stopped. Review the previous turn.",
      },
    ]

    for (const testCase of cases) {
      const tracker = createSessionTracker()
      const sessionID = `session-${testCase.reason}`
      const start = tracker.startTurn({
        sessionID,
        replayEnvelope: createReplayEnvelope(sessionID, `root-${testCase.reason}`),
      })
      const toastCalls: Array<{
        body?: { title?: string; message: string; variant: string; duration?: number }
      }> = []
      const appendPromptCalls: Array<{ body?: { text: string } }> = []

      await escalateToUserJudgment({
        client: {
          tui: {
            async showToast(input: {
              body?: { title?: string; message: string; variant: string; duration?: number }
            }) {
              toastCalls.push(input)
              return { data: true }
            },
            async appendPrompt(input: { body?: { text: string } }) {
              appendPromptCalls.push(input)
              return { data: true }
            },
          },
        },
        tracker,
        sessionID,
        generation: start.generation,
        reason: testCase.reason,
      })

      expect(toastCalls).toEqual([
        {
          body: {
            title: "Retry stopped",
            message: testCase.toastMessage,
            variant: "warning",
            duration: 4000,
          },
        },
      ])
      expect(appendPromptCalls).toEqual([
        {
          body: {
            text: ESCALATION_PROMPT,
          },
        },
      ])
    }
  })
})
