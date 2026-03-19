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

function createReadOnlyBashTruncatedHistory(replayEnvelope: ReplayEnvelope) {
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
        id: "assistant-bash-truncated",
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
          id: "assistant-bash-tool",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-bash-truncated",
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            input: {
              command: "git status --short",
              description: "Shows working tree status",
            },
            output: " M src/index.ts",
            title: "Shows working tree status",
            metadata: {
              output: " M src/index.ts",
              description: "Shows working tree status",
            },
            time: { start: 1, end: 2 },
          },
        },
        {
          id: "assistant-bash-text",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-bash-truncated",
          type: "text",
          text: "{\"answer\": \"worktree",
        },
        {
          id: "assistant-bash-finish",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-bash-truncated",
          type: "step-finish",
          reason: "length",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    },
  ]
}

function createReadOnlyWebFetchTruncatedHistory(replayEnvelope: ReplayEnvelope) {
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
        id: "assistant-webfetch-truncated",
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
          id: "assistant-webfetch-tool",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-webfetch-truncated",
          type: "tool",
          tool: "webfetch",
          state: {
            status: "completed",
            input: {
              url: "https://example.com/docs",
            },
            output: "Fetched example content",
            metadata: {
              contentType: "text/html",
            },
            time: { start: 1, end: 2 },
          },
        },
        {
          id: "assistant-webfetch-text",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-webfetch-truncated",
          type: "text",
          text: "{\"answer\": \"fetched",
        },
        {
          id: "assistant-webfetch-finish",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-webfetch-truncated",
          type: "step-finish",
          reason: "length",
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
    expect(secondSnapshot.tracker.retryCount).toBe(0)
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
        config: {
          async providers() {
            return {
              data: {
                providers: [
                  {
                    id: "openai",
                    name: "OpenAI",
                    source: "config",
                    env: [],
                    key: "host-key",
                    options: {
                      baseURL: "https://example.com/v1",
                    },
                    models: {
                      "gpt-4o-mini": {
                        id: "gpt-4o-mini",
                        providerID: "openai",
                        name: "GPT-4o mini",
                        family: "gpt",
                        api: {
                          id: "gpt-4o-mini",
                          url: "https://example.com/v1",
                          npm: "@ai-sdk/openai",
                        },
                        capabilities: {
                          temperature: true,
                          reasoning: false,
                          attachment: false,
                          toolcall: true,
                          input: { text: true, audio: false, image: false, video: false, pdf: false },
                          output: { text: true, audio: false, image: false, video: false, pdf: false },
                          interleaved: false,
                        },
                        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                        limit: { context: 128_000, output: 8_192 },
                        status: "active",
                        options: {},
                        headers: {},
                        release_date: "2026-01-01",
                      },
                    },
                  },
                ],
              },
            }
          },
        },
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

      await hooks.config?.({
        small_model: "openai/gpt-4o-mini",
        model: "openai/gpt-4o",
      })

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

  test("replays after a completed read-only bash command when the answer truncates later", async () => {
    const sessionID = "session-safe-bash-replay"
    const rootMessageID = "root-safe-bash"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const revertCalls: Array<{ path: { id: string }; body: { messageID: string } }> = []
    const promptCalls: ReplaySubmissionRequest[] = []
    const replaySubmitted = deferred<void>()
    let hooks!: ReturnType<typeof createTruncationRetryHooks>
    let currentHistory = createReadOnlyBashTruncatedHistory(replayEnvelope)

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
          throw new Error("read-only bash replay should not unrevert")
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
              replaySubmitted.resolve()
              return { data: true }
            },
          },
        }),
      },
    )

    const initialArgs = createChatMessageArgs(replayEnvelope)
    await hooks["chat.message"]?.(initialArgs.hookInput as never, initialArgs.hookOutput as never)
    await hooks["tool.execute.after"]?.(
      {
        tool: "bash",
        sessionID,
        callID: "call-bash-1",
        args: {
          command: "git status --short",
          description: "Shows working tree status",
        },
      },
      {
        title: "Shows working tree status",
        output: " M src/index.ts",
        metadata: {
          output: " M src/index.ts",
          description: "Shows working tree status",
        },
      },
    )
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await replaySubmitted.promise

    expect(revertCalls).toEqual([
      {
        path: { id: sessionID },
        body: { messageID: rootMessageID },
      },
    ])
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0].messageID).toBe(rootMessageID)
  })

})
