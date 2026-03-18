import { describe, expect, test } from "bun:test"

import { createTruncationRetryHooks, type IdleSnapshot, type PluginInput } from "../src/index.js"
import type { ReplaySubmissionRequest } from "../src/replay.js"
import { ClassifierResult, type PluginConfig, type ReplayEnvelope, type ReplayFormat, type ReplayModel } from "../src/types.js"

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
  const format: ReplayFormat = {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
      additionalProperties: false,
    },
  }

  return {
    sessionID,
    rootMessageID,
    parts: [
      {
        id: "part-user-1",
        sessionID,
        messageID: rootMessageID,
        type: "text",
        text: "Finish the JSON response.",
      },
    ],
    agent: "safe-agent",
    model,
    system: "Reply with JSON only.",
    format,
    variant: "cli-default",
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
        time: { created: 2, completed: 3 },
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
          id: "assistant-text-1",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-truncated",
          type: "text",
          text: "{\"answer\": \"par",
        },
        {
          id: "assistant-finish-1",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-truncated",
          type: "step-finish",
          reason: "length",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    },
  ]
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
        time: { created: 4, completed: 5 },
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
          id: "assistant-text-2",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-complete",
          type: "text",
          text: "{\"answer\": \"parsed\"}",
        },
        {
          id: "assistant-finish-2",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-complete",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    },
  ]
}

function createClassifierHistory(replayEnvelope: ReplayEnvelope) {
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
        id: "assistant-needs-classifier",
        sessionID: replayEnvelope.sessionID,
        role: "assistant",
        parentID: replayEnvelope.rootMessageID,
        time: { created: 2, completed: 3 },
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
          id: "assistant-text-classifier",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-needs-classifier",
          type: "text",
          text: "{\"answer\":",
        },
        {
          id: "assistant-finish-classifier",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-needs-classifier",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    },
  ]
}

describe("safe auto retry", () => {
  test("reverts to the root boundary and replays the preserved envelope once", async () => {
    const sessionID = "session-safe-replay"
    const rootMessageID = "root-safe-1"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const revertCalls: Array<{ path: { id: string }; body: { messageID: string } }> = []
    const promptCalls: ReplaySubmissionRequest[] = []
    const snapshots: IdleSnapshot[] = []
    const replaySubmitted = deferred<void>()
    const replayedSnapshot = deferred<IdleSnapshot>()
    let hooks!: ReturnType<typeof createTruncationRetryHooks>
    let currentHistory = createTruncatedHistory(replayEnvelope)

    const client = {
      session: {
        async messages() {
          return { data: structuredClone(currentHistory) }
        },
        async status() {
          return { data: {} }
        },
        async revert(input: { path: { id: string }; body: { messageID: string } }) {
          revertCalls.push(input)
          return { data: true }
        },
        async unrevert() {
          throw new Error("safe replay should not unrevert")
        },
      },
      tui: {
        async showToast() {
          throw new Error("safe replay should not notify")
        },
      },
    } as unknown as PluginInput["client"]

    hooks = createTruncationRetryHooks(
      {
        client,
        directory: "/tmp/opencode-retry",
        serverUrl: new URL("https://example.com"),
      },
      {
        config: createEnabledConfig(),
        replayClientFactory: () => ({
          session: {
            async prompt(input) {
              promptCalls.push(structuredClone(input))
              currentHistory = createCompletedHistory(replayEnvelope)
              const replayArgs = createChatMessageArgs(replayEnvelope)
              await hooks["chat.message"]?.(replayArgs.hookInput as never, replayArgs.hookOutput as never)
              replaySubmitted.resolve()
              return { data: true }
            },
          },
        }),
        onIdleSnapshot: (snapshot) => {
          snapshots.push(snapshot)
          if (snapshots.length === 2) {
            replayedSnapshot.resolve(snapshot)
          }
        },
      },
    )

    const initialArgs = createChatMessageArgs(replayEnvelope)
    await hooks["chat.message"]?.(initialArgs.hookInput as never, initialArgs.hookOutput as never)
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await replaySubmitted.promise
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })

    const secondSnapshot = await replayedSnapshot.promise

    expect(revertCalls).toEqual([
      {
        path: { id: sessionID },
        body: { messageID: rootMessageID },
      },
    ])
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]).toEqual({
      sessionID,
      directory: "/tmp/opencode-retry",
      messageID: rootMessageID,
      parts: replayEnvelope.parts,
      agent: replayEnvelope.agent,
      model: replayEnvelope.model,
      system: replayEnvelope.system,
      format: replayEnvelope.format,
      variant: replayEnvelope.variant,
    })
    expect(secondSnapshot.generation).toBe(2)
    expect(secondSnapshot.tracker.rootMessageID).toBe(rootMessageID)
    expect(secondSnapshot.tracker.retryCount).toBe(1)
    expect(promptCalls).toHaveLength(1)
  })

  test("replays when the classifier confirms an otherwise safe ambiguous truncation", async () => {
    const previousFetch = globalThis.fetch
    const sessionID = "session-safe-classifier-replay"
    const rootMessageID = "root-safe-classifier"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const revertCalls: Array<{ path: { id: string }; body: { messageID: string } }> = []
    const promptCalls: ReplaySubmissionRequest[] = []
    const replaySubmitted = deferred<void>()
    let hooks!: ReturnType<typeof createTruncationRetryHooks>
    let currentHistory = createClassifierHistory(replayEnvelope)

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ result: ClassifierResult.TRUNCATED }),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )

    try {
      const client = {
        session: {
          async messages() {
            return { data: structuredClone(currentHistory) }
          },
          async status() {
            return { data: {} }
          },
          async revert(input: { path: { id: string }; body: { messageID: string } }) {
            revertCalls.push(input)
            return { data: true }
          },
          async unrevert() {
            throw new Error("classifier-confirmed safe replay should not unrevert")
          },
        },
        tui: {
          async showToast() {
            throw new Error("classifier-confirmed safe replay should not notify")
          },
          async appendPrompt() {
            throw new Error("classifier-confirmed safe replay should not append prompt")
          },
        },
      } as unknown as PluginInput["client"]

      hooks = createTruncationRetryHooks(
        {
          client,
          directory: "/tmp/opencode-retry",
          serverUrl: new URL("https://example.com"),
        },
        {
          config: createEnabledConfig(),
          replayClientFactory: () => ({
            session: {
              async prompt(input) {
                promptCalls.push(structuredClone(input))
                currentHistory = createCompletedHistory(replayEnvelope)
                const replayArgs = createChatMessageArgs(replayEnvelope)
                await hooks["chat.message"]?.(replayArgs.hookInput as never, replayArgs.hookOutput as never)
                replaySubmitted.resolve()
                return { data: true }
              },
            },
          }),
        },
      )

      const initialArgs = createChatMessageArgs(replayEnvelope)
      await hooks["chat.message"]?.(initialArgs.hookInput as never, initialArgs.hookOutput as never)
      await hooks.event?.({ event: createIdleEvent(sessionID) as never })
      await replaySubmitted.promise

      expect(revertCalls).toEqual([
        {
          path: { id: sessionID },
          body: { messageID: rootMessageID },
        },
      ])
      expect(promptCalls).toHaveLength(1)
      expect(promptCalls[0]).toEqual({
        sessionID,
        directory: "/tmp/opencode-retry",
        messageID: rootMessageID,
        parts: replayEnvelope.parts,
        agent: replayEnvelope.agent,
        model: replayEnvelope.model,
        system: replayEnvelope.system,
        format: replayEnvelope.format,
        variant: replayEnvelope.variant,
      })
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
