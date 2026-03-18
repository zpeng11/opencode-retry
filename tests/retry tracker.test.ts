import { describe, expect, test } from "bun:test"

import { createSessionTracker } from "../src/tracker.js"
import type { ReplayEnvelope } from "../src/types.js"

function createEnvelope(sessionID: string, rootMessageID: string): ReplayEnvelope {
  return {
    sessionID,
    rootMessageID,
    parts: [{ type: "text", text: `prompt:${rootMessageID}` }],
    agent: "test-agent",
    model: "test-model",
    system: "Be helpful",
    format: "markdown",
    variant: "default",
  }
}

describe("retry tracker", () => {
  test("enforces retry limits per root prompt instead of per session", () => {
    const tracker = createSessionTracker()
    const sessionID = "session-1"

    const firstTurn = tracker.startTurn({
      sessionID,
      replayEnvelope: createEnvelope(sessionID, "root-1"),
    })

    expect(firstTurn.generation).toBe(1)
    expect(firstTurn.retryCount).toBe(0)
    expect(tracker.canRetry({ sessionID, maxRetries: 2 })).toBe(true)

    const firstRetry = tracker.recordRetry({ sessionID, maxRetries: 2 })
    expect(firstRetry.recorded).toBe(true)
    expect(firstRetry.snapshot?.retryCount).toBe(1)
    expect(tracker.canRetry({ sessionID, maxRetries: 2 })).toBe(true)

    const secondRetry = tracker.recordRetry({ sessionID, maxRetries: 2 })
    expect(secondRetry.recorded).toBe(true)
    expect(secondRetry.snapshot?.retryCount).toBe(2)
    expect(tracker.canRetry({ sessionID, maxRetries: 2 })).toBe(false)

    const blockedRetry = tracker.recordRetry({ sessionID, maxRetries: 2 })
    expect(blockedRetry.recorded).toBe(false)
    expect(blockedRetry.reason).toBe("retry-limit-reached")

    const secondTurn = tracker.startTurn({
      sessionID,
      replayEnvelope: createEnvelope(sessionID, "root-2"),
    })

    expect(secondTurn.generation).toBe(2)
    expect(secondTurn.rootMessageID).toBe("root-2")
    expect(secondTurn.retryCount).toBe(0)
    expect(tracker.canRetry({ sessionID, maxRetries: 2 })).toBe(true)
  })

  test("restores retry counts for the same root lineage and isolates sessions", () => {
    const tracker = createSessionTracker()

    tracker.startTurn({
      sessionID: "session-1",
      replayEnvelope: createEnvelope("session-1", "root-shared"),
    })

    const retry = tracker.recordRetry({ sessionID: "session-1", maxRetries: 2 })
    expect(retry.recorded).toBe(true)
    expect(retry.snapshot?.retryCount).toBe(1)

    tracker.startTurn({
      sessionID: "session-1",
      replayEnvelope: createEnvelope("session-1", "root-other"),
    })

    const restored = tracker.startTurn({
      sessionID: "session-1",
      replayEnvelope: createEnvelope("session-1", "root-shared"),
    })

    expect(restored.retryCount).toBe(1)
    expect(tracker.canRetry({ sessionID: "session-1", maxRetries: 2 })).toBe(true)

    const otherSession = tracker.startTurn({
      sessionID: "session-2",
      replayEnvelope: createEnvelope("session-2", "root-shared"),
    })

    expect(otherSession.retryCount).toBe(0)
    expect(tracker.canRetry({ sessionID: "session-2", maxRetries: 2 })).toBe(true)
  })

  test("markEscalated and clearSession update the tracked session state", () => {
    const tracker = createSessionTracker()
    const sessionID = "session-3"

    tracker.startTurn({
      sessionID,
      replayEnvelope: createEnvelope(sessionID, "root-1"),
    })

    const escalated = tracker.markEscalated({ sessionID })
    expect(escalated.updated).toBe(true)
    expect(escalated.snapshot?.isEscalated).toBe(true)
    expect(tracker.canRetry({ sessionID, maxRetries: 2 })).toBe(false)

    expect(tracker.getSession(sessionID)?.rootMessageID).toBe("root-1")
    expect(tracker.clearSession(sessionID)).toBe(true)
    expect(tracker.getSession(sessionID)).toBeUndefined()
  })
})
