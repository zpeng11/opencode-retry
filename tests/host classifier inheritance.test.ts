import { describe, expect, test } from "bun:test"

import { createTruncationRetryHooks, type PluginInput } from "../src/index.js"
import type { ReplaySubmissionRequest } from "../src/replay.js"
import { ClassifierResult, type PluginConfig, type ReplayEnvelope, type ReplayModel } from "../src/types.js"

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function createHostInheritedConfig(): PluginConfig {
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

describe("host classifier inheritance", () => {
  test("inherits the classifier model config from the host small_model when env fallback is absent", async () => {
    const previousFetch = globalThis.fetch
    const sessionID = "session-host-inherit"
    const rootMessageID = "root-host-inherit"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const promptCalls: ReplaySubmissionRequest[] = []
    const replaySubmitted = deferred<void>()
    const configProvidersCalls: unknown[] = []
    let hooks!: ReturnType<typeof createTruncationRetryHooks>
    let fetchRequest!: Request

    globalThis.fetch = async (input: string | URL | Request) => {
      fetchRequest = input instanceof Request ? input : new Request(input)
      return new Response(
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
    }

    try {
      const client = {
        config: {
          async providers(input?: unknown) {
            configProvidersCalls.push(input)
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
            return { data: structuredClone(createClassifierHistory(replayEnvelope)) }
          },
          async status() {
            return { data: {} }
          },
          async revert() {
            return { data: true }
          },
          async unrevert() {
            throw new Error("host-inherited replay should not unrevert")
          },
        },
        tui: {
          async showToast() {
            throw new Error("host-inherited replay should not notify")
          },
          async appendPrompt() {
            throw new Error("host-inherited replay should not append prompt")
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
          config: createHostInheritedConfig(),
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

      await hooks.config?.({
        small_model: "openai/gpt-4o-mini",
        model: "openai/gpt-4o",
      })

      const initialArgs = createChatMessageArgs(replayEnvelope)
      await hooks["chat.message"]?.(initialArgs.hookInput as never, initialArgs.hookOutput as never)
      await hooks.event?.({ event: createIdleEvent(sessionID) as never })
      await replaySubmitted.promise

      expect(configProvidersCalls).toHaveLength(1)
      expect(fetchRequest.url).toBe("https://example.com/v1/chat/completions")
      expect(fetchRequest.headers.get("authorization")).toBe("Bearer host-key")
      expect(await fetchRequest.json()).toMatchObject({
        model: "gpt-4o-mini",
      })
      expect(promptCalls).toHaveLength(1)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
