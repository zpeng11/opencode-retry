import { describe, expect, test } from "bun:test"

import { RECENT_MESSAGE_PAGE_SIZE, attemptSafeReplayTransaction } from "../src/replay.js"
import { createSessionTracker } from "../src/tracker.js"
import type { PluginConfig, ReplayEnvelope, ReplayFormat, ReplayModel } from "../src/types.js"

function createEnabledConfig(): PluginConfig {
  return {
    enabled: true,
    classifierEndpoint: "https://example.com/v1/chat/completions",
    classifierModel: "gpt-4o-mini",
    classifierApiKey: "test-key",
    classifierTimeoutMs: 500,
    maxRetries: 2,
  }
}

function createReplayEnvelope(sessionID: string, rootMessageID: string): ReplayEnvelope {
  const model: ReplayModel = { providerID: "openai", modelID: "gpt-4o" }
  const format: ReplayFormat = { type: "text" }

  return {
    sessionID,
    rootMessageID,
    parts: [{ type: "text", text: "Summarize the result." }],
    agent: "paging-agent",
    model,
    system: "Stay concise.",
    format,
    variant: "default",
  }
}

function createCompletedHistory(replayEnvelope: ReplayEnvelope) {
  return [
    {
      info: {
        id: replayEnvelope.rootMessageID,
        role: "user",
      },
      parts: replayEnvelope.parts,
    },
    {
      info: {
        id: "assistant-complete",
        sessionID: replayEnvelope.sessionID,
        role: "assistant",
        parentID: replayEnvelope.rootMessageID,
        time: { created: 1, completed: 2 },
        modelID: "gpt-4o",
        providerID: "openai",
        mode: "chat",
        agent: replayEnvelope.agent,
        path: { cwd: "/tmp/opencode-retry", root: "/tmp/opencode-retry" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "assistant-text-complete",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-complete",
          type: "text",
          text: "All done.",
        },
      ],
    },
  ]
}

function createRecentWindowWithoutAssistant(sessionID: string) {
  return Array.from({ length: RECENT_MESSAGE_PAGE_SIZE }, (_, index) => ({
    info: {
      id: `user-window-${index}`,
      sessionID,
      role: "user",
    },
    parts: [
      {
        id: `part-user-window-${index}`,
        sessionID,
        messageID: `user-window-${index}`,
        type: "text",
        text: `Older prompt ${index}`,
      },
    ],
  }))
}

describe("recent message paging", () => {
  test("uses only the recent message page when it already includes the last assistant turn", async () => {
    const sessionID = "session-paging-recent"
    const rootMessageID = "root-paging-recent"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    const messageRequests: Array<{ path: { id: string }; query?: { limit?: number; before?: string } }> = []

    const result = await attemptSafeReplayTransaction({
      client: {
        session: {
          async messages(input: { path: { id: string }; query?: { limit?: number; before?: string } }) {
            messageRequests.push(structuredClone(input))

            if (input.query?.limit === RECENT_MESSAGE_PAGE_SIZE) {
              return { data: structuredClone(createCompletedHistory(replayEnvelope)) }
            }

            throw new Error("recent page should have been enough")
          },
          async status() {
            return { data: {} }
          },
        },
      },
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: start.generation,
      recentToolOutcomes: [],
    })

    expect(result).toEqual({ outcome: "ignored", reason: "normal-turn" })
    expect(messageRequests).toEqual([
      {
        path: { id: sessionID },
        query: { limit: RECENT_MESSAGE_PAGE_SIZE },
      },
    ])
  })

  test("falls back to the full history when the recent page cannot find an assistant turn", async () => {
    const sessionID = "session-paging-fallback"
    const rootMessageID = "root-paging-fallback"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    const messageRequests: Array<{ path: { id: string }; query?: { limit?: number; before?: string } }> = []

    const result = await attemptSafeReplayTransaction({
      client: {
        session: {
          async messages(input: { path: { id: string }; query?: { limit?: number; before?: string } }) {
            messageRequests.push(structuredClone(input))

            if (input.query?.limit === RECENT_MESSAGE_PAGE_SIZE) {
              return { data: structuredClone(createRecentWindowWithoutAssistant(sessionID)) }
            }

            return { data: structuredClone(createCompletedHistory(replayEnvelope)) }
          },
          async status() {
            return { data: {} }
          },
        },
      },
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: start.generation,
      recentToolOutcomes: [],
    })

    expect(result).toEqual({ outcome: "ignored", reason: "normal-turn" })
    expect(messageRequests).toEqual([
      {
        path: { id: sessionID },
        query: { limit: RECENT_MESSAGE_PAGE_SIZE },
      },
      {
        path: { id: sessionID },
      },
    ])
  })
})
