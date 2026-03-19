import { describe, expect, test } from "bun:test"

import { createTruncationRetryHooks, type PluginInput } from "../src/index.js"
import type { PluginConfig, ReplayEnvelope, ReplayModel } from "../src/types.js"

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

  return {
    sessionID,
    rootMessageID,
    parts: [{ type: "text", text: "Try again safely." }],
    agent: "unsafe-agent",
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

function createUnsafeHistory(replayEnvelope: ReplayEnvelope) {
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
        id: "assistant-unsafe",
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
          id: "assistant-text-unsafe",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-unsafe",
          type: "text",
          text: "partial update",
        },
        {
          id: "assistant-patch-unsafe",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-unsafe",
          type: "patch",
          files: ["src/example.ts"],
        },
      ],
    },
  ]
}

describe("unsafe side effects escalate", () => {
  test("requires explicit user judgment when the previous turn may have mutated state", async () => {
    const sessionID = "session-unsafe"
    const rootMessageID = "root-unsafe"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const warningWritten = deferred<void>()
    const partUpdateCalls: Array<{ messageID: string; partID: string; part?: unknown }> = []
    let replayFactoryCalls = 0

    const hooks = createTruncationRetryHooks(
      {
        client: {
          session: {
            async messages() {
              return { data: structuredClone(createUnsafeHistory(replayEnvelope)) }
            },
            async status() {
              return { data: {} }
            },
            async revert() {
              throw new Error("unsafe turn should not revert")
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
              warningWritten.resolve()
              return { data: true }
            },
          },
        }),
        replayClientFactory: () => {
          replayFactoryCalls += 1
          return {
            session: {
              async prompt() {
                throw new Error("unsafe turn should not replay")
              },
            },
          }
        },
      },
    )

    const args = createChatMessageArgs(replayEnvelope)
    await hooks["chat.message"]?.(args.hookInput as never, args.hookOutput as never)
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await warningWritten.promise

    expect(replayFactoryCalls).toBe(0)
    expect(partUpdateCalls).toHaveLength(1)
    expect(partUpdateCalls[0]).toMatchObject({
      messageID: "assistant-unsafe",
      partID: "assistant-text-unsafe",
    })
  })
})
