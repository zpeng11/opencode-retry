import { describe, expect, test } from "bun:test"

import { attemptSafeReplayTransaction } from "../src/replay.js"
import { createSessionTracker } from "../src/tracker.js"
import type { PluginConfig, ReplayEnvelope, ReplayModel } from "../src/types.js"

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

  return {
    sessionID,
    rootMessageID,
    parts: [{ type: "text", text: "Complete the answer." }],
    agent: "budget-agent",
    model,
    system: "Stay on task.",
    format: { type: "text" },
    variant: "default",
  }
}

function createTruncatedHistory(replayEnvelope: ReplayEnvelope) {
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
        id: "assistant-budget",
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
        finish: "length",
      },
      parts: [
        {
          id: "assistant-text-budget",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-budget",
          type: "text",
          text: "truncated output",
        },
      ],
    },
  ]
}

describe("retry budget enforced", () => {
  test("a new turn starts with a fresh retry budget", async () => {
    const sessionID = "session-retry-budget"
    const rootMessageID = "root-retry-budget"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const revertCalls: Array<{ path: { id: string }; body: { messageID: string } }> = []
    const promptCalls: Array<{ sessionID: string; messageID?: string }> = []
    const toastCalls: Array<{
      body?: { title?: string; message: string; variant: string; duration?: number }
    }> = []
    const appendPromptCalls: Array<{ body?: { text: string } }> = []

    const client = {
      session: {
        async messages() {
          return { data: structuredClone(createTruncatedHistory(replayEnvelope)) }
        },
        async status() {
          return { data: {} }
        },
        async revert(input: { path: { id: string }; body: { messageID: string } }) {
          revertCalls.push(input)
          return { data: true }
        },
        async unrevert() {
          throw new Error("retry budget path should not unrevert")
        },
      },
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
    }

    const firstTurn = tracker.startTurn({ sessionID, replayEnvelope })
    const firstResult = await attemptSafeReplayTransaction({
      client,
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: firstTurn.generation,
      recentToolOutcomes: [],
      directory: "/tmp/opencode-retry",
      serverUrl: new URL("https://example.com"),
      replayClientFactory: () => ({
        session: {
          async prompt(input) {
            promptCalls.push({ sessionID: input.sessionID, messageID: input.messageID })
            return { data: true }
          },
        },
      }),
    })

    const secondTurn = tracker.startTurn({ sessionID, replayEnvelope })
    const secondResult = await attemptSafeReplayTransaction({
      client,
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: secondTurn.generation,
      recentToolOutcomes: [],
      directory: "/tmp/opencode-retry",
      serverUrl: new URL("https://example.com"),
      replayClientFactory: () => ({
        session: {
          async prompt(input) {
            promptCalls.push({ sessionID: input.sessionID, messageID: input.messageID })
            return { data: true }
          },
        },
      }),
    })

    const thirdTurn = tracker.startTurn({ sessionID, replayEnvelope })
    const thirdResult = await attemptSafeReplayTransaction({
      client,
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: thirdTurn.generation,
      recentToolOutcomes: [],
      directory: "/tmp/opencode-retry",
      serverUrl: new URL("https://example.com"),
      replayClientFactory: () => ({
        session: {
          async prompt(input) {
            promptCalls.push({ sessionID: input.sessionID, messageID: input.messageID })
            return { data: true }
          },
        },
      }),
    })

    expect(firstResult).toEqual({ outcome: "replayed", retryCount: 1 })
    expect(secondResult).toEqual({ outcome: "replayed", retryCount: 1 })
    expect(thirdTurn.retryCount).toBe(0)
    expect(thirdResult).toEqual({ outcome: "replayed", retryCount: 1 })
    expect(revertCalls).toEqual([
      {
        path: { id: sessionID },
        body: { messageID: rootMessageID },
      },
      {
        path: { id: sessionID },
        body: { messageID: rootMessageID },
      },
      {
        path: { id: sessionID },
        body: { messageID: rootMessageID },
      },
    ])
    expect(promptCalls).toEqual([
      { sessionID, messageID: rootMessageID },
      { sessionID, messageID: rootMessageID },
      { sessionID, messageID: rootMessageID },
    ])
    expect(tracker.getSession(sessionID)?.retryCount).toBe(1)
    expect(tracker.getSession(sessionID)?.isEscalated).toBe(false)
    expect(toastCalls).toEqual([])
    expect(appendPromptCalls).toEqual([])
  })
})
