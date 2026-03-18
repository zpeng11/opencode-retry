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
    parts: [{ type: "text", text: "Inspect the previous result." }],
    agent: "dedupe-agent",
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
        id: "assistant-dedupe-unsafe",
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
          id: "assistant-text-dedupe-unsafe",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-dedupe-unsafe",
          type: "text",
          text: "partial update",
        },
        {
          id: "assistant-patch-dedupe-unsafe",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-dedupe-unsafe",
          type: "patch",
          files: ["src/example.ts"],
        },
      ],
    },
  ]
}

describe("escalation dedupe", () => {
  test("does not re-toast or re-append after the same turn is already escalated", async () => {
    const sessionID = "session-escalation-dedupe"
    const rootMessageID = "root-escalation-dedupe"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const promptAppended = deferred<void>()
    const toastCalls: Array<{
      body?: { title?: string; message: string; variant: string; duration?: number }
    }> = []
    const appendPromptCalls: Array<{ body?: { text: string } }> = []
    let messagesCallCount = 0

    const hooks = createTruncationRetryHooks(
      {
        client: {
          session: {
            async messages() {
              messagesCallCount += 1
              return { data: structuredClone(createUnsafeHistory(replayEnvelope)) }
            },
            async status() {
              return { data: {} }
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
              promptAppended.resolve()
              return { data: true }
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
    await promptAppended.promise
    await new Promise((resolve) => setTimeout(resolve, 0))

    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await Promise.resolve()
    await Promise.resolve()

    expect(messagesCallCount).toBe(2)
    expect(toastCalls).toHaveLength(1)
    expect(appendPromptCalls).toHaveLength(1)
  })
})
