import { describe, expect, test } from "bun:test"

import {
  ESCALATION_REVIEW_INSTRUCTION,
  appendEscalationWarningToAssistantText,
  type JudgmentEscalationReason,
} from "../src/escalation.js"

describe("escalation copy", () => {
  test("maps each escalation reason to the expected transcript warning copy", () => {
    const cases: Array<{ reason: JudgmentEscalationReason; message: string }> = [
      {
        reason: "unsafe-turn",
        message: "Previous turn may already have caused side effects.",
      },
      {
        reason: "classifier-truncated",
        message: "Previous turn may have been truncated.",
      },
      {
        reason: "maybe-truncated-needs-judgment",
        message: "Possible truncation needs your review.",
      },
      {
        reason: "retry-budget-exhausted",
        message: "Automatic retries stopped. Review the previous turn.",
      },
      {
        reason: "replay-revert-failed",
        message: "Automatic retry failed while reverting the previous turn. Review the session state carefully.",
      },
      {
        reason: "replay-submit-failed",
        message: "Automatic retry failed. Session restored.",
      },
      {
        reason: "replay-rollback-failed",
        message: "Retry failed. Unable to restore session. Review the state carefully.",
      },
      {
        reason: "replay-bootstrap-failed",
        message: "Automatic retry stopped.",
      },
      {
        reason: "missing-replay-envelope",
        message: "Automatic retry stopped. Review the previous turn.",
      },
    ]

    for (const testCase of cases) {
      const warning = appendEscalationWarningToAssistantText("Partial answer", testCase.reason)
      expect(warning).toContain(`Warning: ${testCase.message}`)
      expect(warning).toContain(ESCALATION_REVIEW_INSTRUCTION)
      expect(warning).toContain("not sent back to the agent")
    }
  })
})
