import { describe, expect, test } from "bun:test"

import { createSessionTracker } from "../src/tracker.js"
import type { ReplayEnvelope } from "../src/types.js"

function createEnvelope(sessionID: string, rootMessageID: string): ReplayEnvelope {
  return {
    sessionID,
    rootMessageID,
    parts: [{ type: "text", text: `prompt:${rootMessageID}` }],
  }
}

describe("generation token", () => {
  test("cancelGeneration bumps the token and blocks stale retry attempts", () => {
    const tracker = createSessionTracker()
    const sessionID = "session-2"

    const started = tracker.startTurn({
      sessionID,
      replayEnvelope: createEnvelope(sessionID, "root-1"),
    })

    const idle = tracker.recordIdleCandidate({
      sessionID,
      generation: started.generation,
      lastAssistantMessageID: "assistant-1",
    })

    expect(idle.accepted).toBe(true)

    const canceled = tracker.cancelGeneration({
      sessionID,
      generation: started.generation,
    })

    expect(canceled.updated).toBe(true)
    expect(canceled.snapshot?.generation).toBe(2)
    expect(canceled.snapshot?.pendingIdleGeneration).toBeUndefined()
    expect(canceled.snapshot?.lastAssistantMessageID).toBeUndefined()
    expect(canceled.snapshot?.rootMessageID).toBe("root-1")

    const staleRetry = tracker.recordRetry({
      sessionID,
      generation: started.generation,
      maxRetries: 2,
    })

    expect(staleRetry.recorded).toBe(false)
    expect(staleRetry.reason).toBe("stale-generation")
    expect(tracker.canRetry({ sessionID, generation: 2, maxRetries: 2 })).toBe(true)
  })
})
