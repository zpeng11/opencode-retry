import { describe, expect, test } from "bun:test"

import { createTruncationRetryHooks, type PluginInput } from "../src/index.js"
import { attemptSafeReplayTransaction } from "../src/replay.js"
import { createSessionTracker } from "../src/tracker.js"
import type { PluginConfig, ReplayEnvelope, ReplayModel } from "../src/types.js"

function createEnabledConfig(): PluginConfig {
  return {
    enabled: true,
    classifierTimeoutMs: 500,
    maxRetries: 2,
  }
}

function createReplayEnvelope(sessionID: string, rootMessageID: string): ReplayEnvelope {
  const model: ReplayModel = { providerID: "openai", modelID: "gpt-4o" }

  return {
    sessionID,
    rootMessageID,
    parts: [{ type: "text", text: "Continue the reply safely." }],
    agent: "error-agent",
    model,
    system: "Stay concise.",
    format: { type: "text" },
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

function createErrorHistory(
  replayEnvelope: ReplayEnvelope,
  error: Record<string, unknown>,
  assistantMessageID: string,
) {
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
        id: assistantMessageID,
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
        error,
      },
      parts: [
        {
          id: `${assistantMessageID}-text`,
          sessionID: replayEnvelope.sessionID,
          messageID: assistantMessageID,
          type: "text",
          text: "Here is the partial reply",
        },
        {
          id: `${assistantMessageID}-finish`,
          sessionID: replayEnvelope.sessionID,
          messageID: assistantMessageID,
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    },
  ]
}

describe("non truncation errors ignored", () => {
  const cases = [
    {
      label: "aborted turns",
      error: { name: "MessageAbortedError", message: "User aborted the response." },
      reason: "assistant-aborted" as const,
    },
    {
      label: "provider auth failures",
      error: { name: "ProviderAuthError", providerID: "openai", message: "Missing API key." },
      reason: "assistant-auth-error" as const,
    },
    {
      label: "context overflow failures",
      error: { name: "ContextOverflowError", message: "Context window exceeded." },
      reason: "assistant-context-overflow" as const,
    },
    {
      label: "api failures",
      error: { name: "APIError", message: "Upstream failed.", isRetryable: true },
      reason: "assistant-api-error" as const,
    },
    {
      label: "unknown failures",
      error: { name: "UnknownError", message: "Something unexpected happened." },
      reason: "assistant-error" as const,
    },
  ] as const

  for (const testCase of cases) {
    test(`ignores ${testCase.label} without classifier or replay`, async () => {
      const previousFetch = globalThis.fetch
      const sessionID = `session-${testCase.reason}`
      const rootMessageID = `root-${testCase.reason}`
      const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
      const tracker = createSessionTracker()
      const start = tracker.startTurn({ sessionID, replayEnvelope })
      let revertCalls = 0
      let replayFactoryCalls = 0
      let fetchCalls = 0

      globalThis.fetch = async () => {
        fetchCalls += 1
        throw new Error("classifier should not run for non-truncation errors")
      }

      try {
        const result = await attemptSafeReplayTransaction({
          client: {
            session: {
              async messages() {
                return {
                  data: structuredClone(createErrorHistory(replayEnvelope, testCase.error, `assistant-${testCase.reason}`)),
                }
              },
              async status() {
                return { data: {} }
              },
              async revert() {
                revertCalls += 1
                throw new Error("non-truncation errors should not revert")
              },
            },
          },
          tracker,
          config: createEnabledConfig(),
          sessionID,
          generation: start.generation,
          directory: "/tmp/opencode-retry",
          serverUrl: new URL("http://localhost:4096"),
          replayClientFactory: () => {
            replayFactoryCalls += 1
            return {
              session: {
                async prompt() {
                  throw new Error("non-truncation errors should not replay")
                },
              },
            }
          },
        })

        expect(result).toEqual({
          outcome: "ignored",
          reason: testCase.reason,
        })
        expect(fetchCalls).toBe(0)
        expect(revertCalls).toBe(0)
        expect(replayFactoryCalls).toBe(0)
      } finally {
        globalThis.fetch = previousFetch
      }
    })
  }

  test("cleans up session tracking after ignoring a non-truncation error", async () => {
    const previousFetch = globalThis.fetch
    const sessionID = "session-cleanup-non-truncation"
    const rootMessageID = "root-cleanup-non-truncation"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    let messagesCallCount = 0
    let fetchCalls = 0

    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error("classifier should not run for non-truncation errors")
    }

    try {
      const hooks = createTruncationRetryHooks(
        {
          client: {
            session: {
              async messages() {
                messagesCallCount += 1
                return {
                  data: structuredClone(
                    createErrorHistory(
                      replayEnvelope,
                      { name: "MessageAbortedError", message: "User aborted the response." },
                      "assistant-cleanup-non-truncation",
                    ),
                  ),
                }
              },
              async status() {
                return { data: {} }
              },
            },
          } as unknown as PluginInput["client"],
        },
        {
          config: createEnabledConfig(),
        },
      )

      const args = createChatMessageArgs(replayEnvelope)
      await hooks["chat.message"]?.(args.hookInput as never, args.hookOutput as never)
      await hooks.event?.({ event: createIdleEvent(sessionID) as never })
      await Promise.resolve()
      await Promise.resolve()

      await hooks.event?.({ event: createIdleEvent(sessionID) as never })
      await Promise.resolve()

      expect(messagesCallCount).toBe(1)
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
