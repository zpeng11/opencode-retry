import { describe, expect, test } from "bun:test"

import { createTruncationRetryHooks, type PluginInput } from "../src/index.js"
import { attemptSafeReplayTransaction } from "../src/replay.js"
import { createSessionTracker } from "../src/tracker.js"
import type { PluginConfig, ReplayEnvelope, ReplayFormat, ReplayModel } from "../src/types.js"

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

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
    agent: "revert-agent",
    model,
    system: "Be concise.",
    format,
    variant: "default",
  }
}

function createChatMessageArgs(replayEnvelope: ReplayEnvelope) {
  return {
    hookInput: {
      sessionID: replayEnvelope.sessionID,
      agent: replayEnvelope.agent,
      model: replayEnvelope.model,
      messageID: replayEnvelope.rootMessageID,
      variant: replayEnvelope.variant,
    },
    hookOutput: {
      message: {
        id: replayEnvelope.rootMessageID,
        sessionID: replayEnvelope.sessionID,
        role: "user",
        time: { created: 1 },
        agent: replayEnvelope.agent,
        model: replayEnvelope.model,
        system: replayEnvelope.system,
        format: replayEnvelope.format,
        variant: replayEnvelope.variant,
      } as unknown,
      parts: replayEnvelope.parts as unknown[],
    },
  }
}

function createIdleEvent(sessionID: string) {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status: { type: "idle" },
    },
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
        id: "assistant-truncated",
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
          id: "assistant-text-truncated",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-truncated",
          type: "text",
          text: "partial answer",
        },
      ],
    },
  ]
}

describe("revert failure handling", () => {
  test("escalates with replay-revert-failed when revert fails outside a busy race", async () => {
    const sessionID = "session-revert-failure"
    const rootMessageID = "root-revert-failure"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    const partUpdateCalls: Array<{ messageID: string; partID: string; part?: unknown }> = []
    let revertCalls = 0
    let promptCalls = 0

    const result = await attemptSafeReplayTransaction({
      client: {
        session: {
          async messages() {
            return { data: structuredClone(createTruncatedHistory(replayEnvelope)) }
          },
          async status() {
            return { data: {} }
          },
          async revert() {
            revertCalls += 1
            throw new Error("snapshot revert failed")
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
            promptCalls += 1
            return { data: true }
          },
        },
      }),
    })

    expect(result).toEqual({ outcome: "escalated", reason: "replay-revert-failed" })
    expect(revertCalls).toBe(1)
    expect(promptCalls).toBe(0)
    expect(tracker.getSession(sessionID)?.isEscalated).toBe(true)
    expect(tracker.getSession(sessionID)?.retryCount).toBe(0)
    expect(partUpdateCalls).toHaveLength(1)
    expect(partUpdateCalls[0]).toMatchObject({
      messageID: "assistant-truncated",
      partID: "assistant-text-truncated",
    })
  })

  test("cleans up hook state after replay-revert-failed so the same turn is not retried again", async () => {
    const sessionID = "session-revert-failure-cleanup"
    const rootMessageID = "root-revert-failure-cleanup"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const partUpdated = deferred<void>()
    let messagesCallCount = 0
    let revertCalls = 0
    let promptCalls = 0
    const partUpdateCalls: Array<{ messageID: string; partID: string; part?: unknown }> = []

    const hooks = createTruncationRetryHooks(
      {
        client: {
          session: {
            async messages() {
              messagesCallCount += 1
              return { data: structuredClone(createTruncatedHistory(replayEnvelope)) }
            },
            async status() {
              return { data: {} }
            },
            async revert() {
              revertCalls += 1
              throw new Error("snapshot revert failed")
            },
          },
        } as unknown as PluginInput["client"],
        directory: "/tmp/opencode-retry",
        serverUrl: new URL("https://example.com"),
      },
      {
        config: createEnabledConfig(),
        escalationWarningClientFactory: () => ({
          part: {
            async update(input: { messageID: string; partID: string; part?: unknown }) {
              partUpdateCalls.push(input)
              partUpdated.resolve()
              return { data: true }
            },
          },
        }),
        replayClientFactory: () => ({
          session: {
            async prompt() {
              promptCalls += 1
              return { data: true }
            },
          },
        }),
      },
    )

    const args = createChatMessageArgs(replayEnvelope)
    await hooks["chat.message"]?.(args.hookInput as never, args.hookOutput as never)
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await partUpdated.promise

    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await Promise.resolve()

    expect(messagesCallCount).toBe(1)
    expect(revertCalls).toBe(1)
    expect(promptCalls).toBe(0)
    expect(partUpdateCalls).toHaveLength(1)
  })

  test("treats a busy revert failure as recoverable and allows the same generation to retry", async () => {
    const sessionID = "session-revert-busy-race"
    const rootMessageID = "root-revert-busy-race"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const tracker = createSessionTracker()
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    const replayed = deferred<void>()
    let messagesCallCount = 0
    let statusCallCount = 0
    let revertCalls = 0
    let promptCalls = 0

    const client = {
      session: {
        async messages() {
          messagesCallCount += 1
          return { data: structuredClone(createTruncatedHistory(replayEnvelope)) }
        },
        async status() {
          statusCallCount += 1

          if (statusCallCount === 3) {
            return { data: { [sessionID]: { type: "busy" } } }
          }

          return { data: {} }
        },
        async revert() {
          revertCalls += 1

          if (revertCalls === 1) {
            throw new Error(`Session ${sessionID} is busy`)
          }

          return { data: true }
        },
      },
    }

    const firstIdle = tracker.recordIdleCandidate({
      sessionID,
      generation: start.generation,
    })
    expect(firstIdle.accepted).toBe(true)

    const firstResult = await attemptSafeReplayTransaction({
      client,
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: start.generation,
      recentToolOutcomes: [],
      directory: "/tmp/opencode-retry",
      serverUrl: new URL("https://example.com"),
      replayClientFactory: () => ({
        session: {
          async prompt() {
            promptCalls += 1
            replayed.resolve()
            return { data: true }
          },
        },
      }),
    })

    expect(firstResult).toEqual({ outcome: "ignored", reason: "busy-session" })

    const secondIdle = tracker.recordIdleCandidate({
      sessionID,
      generation: start.generation,
    })
    expect(secondIdle.accepted).toBe(true)

    const secondResult = await attemptSafeReplayTransaction({
      client,
      tracker,
      config: createEnabledConfig(),
      sessionID,
      generation: start.generation,
      recentToolOutcomes: [],
      directory: "/tmp/opencode-retry",
      serverUrl: new URL("https://example.com"),
      replayClientFactory: () => ({
        session: {
          async prompt() {
            promptCalls += 1
            replayed.resolve()
            return { data: true }
          },
        },
      }),
    })

    await replayed.promise

    expect(secondResult).toEqual({ outcome: "replayed", retryCount: 1 })
    expect(messagesCallCount).toBe(2)
    expect(statusCallCount).toBe(6)
    expect(revertCalls).toBe(2)
    expect(promptCalls).toBe(1)
  })
})
