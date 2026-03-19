import { describe, expect, test } from "bun:test"

import { attemptSafeReplayTransaction } from "../src/replay.js"
import { createSessionTracker } from "../src/tracker.js"
import type { PluginConfig, ReplayEnvelope, ReplayFormat, ReplayModel } from "../src/types.js"

function createEnabledConfig(): PluginConfig {
  return {
    enabled: true,
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
    parts: [{ type: "text", text: "Try again safely." }],
    agent: "rollback-agent",
    model,
    system: "Be concise.",
    format,
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
        id: "assistant-failure",
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
          id: "assistant-text-failure",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-failure",
          type: "text",
          text: "partial answer",
        },
      ],
    },
  ]
}

describe("replay failure unrevert", () => {
  test("rolls back with unrevert, marks escalated, and notifies when replay submission fails", async () => {
    const sessionID = "session-replay-failure"
    const rootMessageID = "root-replay-failure"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    const revertCalls: Array<{ path: { id: string }; body: { messageID: string } }> = []
    const unrevertCalls: Array<{ path: { id: string } }> = []
    const partUpdateCalls: Array<{ messageID: string; partID: string; part?: unknown }> = []

    const result = await attemptSafeReplayTransaction({
      client: {
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
          async unrevert(input: { path: { id: string } }) {
            unrevertCalls.push(input)
            return { data: true }
          },
        },
      },
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: start.generation,
      recentToolOutcomes: [],
      directory: "/tmp/opencode-retry",
      serverUrl: new URL("https://example.com"),
      escalationWarningClientFactory: () => ({
        part: {
          async update(input: { messageID: string; partID: string; part?: unknown }) {
            partUpdateCalls.push(input)
            return { data: true }
          },
        },
      }),
      replayClientFactory: () => ({
        session: {
          async prompt() {
            throw new Error("replay submit failed")
          },
        },
      }),
    })

    expect(result).toEqual({ outcome: "escalated", reason: "replay-submit-failed" })
    expect(revertCalls).toEqual([
      {
        path: { id: sessionID },
        body: { messageID: rootMessageID },
      },
    ])
    expect(unrevertCalls).toEqual([{ path: { id: sessionID } }])
    expect(tracker.getSession(sessionID)?.isEscalated).toBe(true)
    expect(tracker.getSession(sessionID)?.retryCount).toBe(1)
    expect(partUpdateCalls).toHaveLength(1)
    expect(partUpdateCalls[0]).toMatchObject({
      messageID: "assistant-failure",
      partID: "assistant-text-failure",
    })
  })

  test("escalates with replay-rollback-failed when both replay submit and unrevert fail", async () => {
    const sessionID = "session-replay-and-rollback-failure"
    const rootMessageID = "root-replay-and-rollback-failure"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    const revertCalls: Array<{ path: { id: string }; body: { messageID: string } }> = []
    const unrevertCalls: Array<{ path: { id: string } }> = []
    const partUpdateCalls: Array<{ messageID: string; partID: string; part?: unknown }> = []

    const result = await attemptSafeReplayTransaction({
      client: {
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
          async unrevert(input: { path: { id: string } }) {
            unrevertCalls.push(input)
            throw new Error("unrevert also failed")
          },
        },
      },
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: start.generation,
      recentToolOutcomes: [],
      directory: "/tmp/opencode-retry",
      serverUrl: new URL("https://example.com"),
      escalationWarningClientFactory: () => ({
        part: {
          async update(input: { messageID: string; partID: string; part?: unknown }) {
            partUpdateCalls.push(input)
            return { data: true }
          },
        },
      }),
      replayClientFactory: () => ({
        session: {
          async prompt() {
            throw new Error("replay submit failed")
          },
        },
      }),
    })

    expect(result).toEqual({ outcome: "escalated", reason: "replay-rollback-failed" })
    expect(revertCalls.length).toBe(1)
    expect(unrevertCalls.length).toBe(1)
    expect(tracker.getSession(sessionID)?.isEscalated).toBe(true)
    expect(tracker.getSession(sessionID)?.retryCount).toBe(1)
    expect(partUpdateCalls).toHaveLength(1)
    expect(partUpdateCalls[0]).toMatchObject({
      messageID: "assistant-failure",
      partID: "assistant-text-failure",
    })
  })
})
