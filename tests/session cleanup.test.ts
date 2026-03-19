import { describe, expect, test } from "bun:test"

import { createTruncationRetryHooks, type PluginInput } from "../src/index.js"
import type { PluginConfig } from "../src/types.js"

function createEnabledConfig(): PluginConfig {
  return {
    enabled: true,
    classifierTimeoutMs: 500,
    maxRetries: 2,
  }
}

function createChatMessageArgs(sessionID: string, rootMessageID: string) {
  return {
    hookInput: {
      sessionID,
      agent: "cleanup-agent",
      model: { providerID: "openai", modelID: "gpt-4o" },
      messageID: rootMessageID,
      variant: "default",
    },
    hookOutput: {
      message: {
        id: rootMessageID,
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "cleanup-agent",
        model: { providerID: "openai", modelID: "gpt-4o" },
        system: "Stay concise.",
      } as unknown,
      parts: [
        {
          id: "part-user-cleanup",
          sessionID,
          messageID: rootMessageID,
          type: "text",
          text: "Tell me the status.",
        },
      ] as unknown[],
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

function createCompletedHistory(sessionID: string, rootMessageID: string) {
  return [
    {
      info: {
        id: rootMessageID,
        role: "user",
      },
      parts: [
        {
          id: "part-user-cleanup",
          sessionID,
          messageID: rootMessageID,
          type: "text",
          text: "Tell me the status.",
        },
      ],
    },
    {
      info: {
        id: "assistant-cleanup",
        sessionID,
        role: "assistant",
        parentID: rootMessageID,
        time: { created: 1, completed: 2 },
        modelID: "gpt-4o",
        providerID: "openai",
        mode: "chat",
        agent: "cleanup-agent",
        path: { cwd: "/tmp/opencode-retry", root: "/tmp/opencode-retry" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "assistant-text-cleanup",
          sessionID,
          messageID: "assistant-cleanup",
          type: "text",
          text: "Everything completed successfully.",
        },
      ],
    },
  ]
}

describe("session cleanup", () => {
  test("cleans up session tracking after a normal turn is ignored", async () => {
    const sessionID = "session-cleanup-normal"
    const rootMessageID = "root-cleanup-normal"
    let messagesCallCount = 0

    const hooks = createTruncationRetryHooks(
      {
        client: {
          session: {
            async messages() {
              messagesCallCount += 1
              return { data: structuredClone(createCompletedHistory(sessionID, rootMessageID)) }
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

    const args = createChatMessageArgs(sessionID, rootMessageID)
    await hooks["chat.message"]?.(args.hookInput as never, args.hookOutput as never)
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await Promise.resolve()
    await Promise.resolve()

    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await Promise.resolve()

    expect(messagesCallCount).toBe(1)
  })
})
