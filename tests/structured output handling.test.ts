import { describe, expect, test } from "bun:test"

import { createTruncationRetryHooks, type PluginInput } from "../src/index.js"
import { attemptSafeReplayTransaction } from "../src/replay.js"
import { classifyCompletedToolExecution, classifyMessagePartSideEffect } from "../src/side-effects.js"
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
    parts: [{ type: "text", text: "Return valid structured output." }],
    agent: "structured-agent",
    model,
    system: "Reply with JSON only.",
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

function createStructuredOutputCompleteHistory(replayEnvelope: ReplayEnvelope) {
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
        id: "assistant-structured-complete",
        sessionID: replayEnvelope.sessionID,
        role: "assistant",
        parentID: replayEnvelope.rootMessageID,
        finish: "tool-calls",
        structured: {
          answer: "parsed",
        },
      },
      parts: [
        {
          id: "assistant-structured-tool",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-structured-complete",
          type: "tool",
          tool: "StructuredOutput",
          state: {
            status: "completed",
            input: { answer: "parsed" },
            output: "Structured output captured successfully.",
            title: "Structured Output",
            metadata: { valid: true },
            time: { start: 1, end: 2 },
          },
        },
      ],
    },
  ]
}

function createStructuredOutputRunningTruncatedHistory(replayEnvelope: ReplayEnvelope) {
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
        id: "assistant-structured-running",
        sessionID: replayEnvelope.sessionID,
        role: "assistant",
        parentID: replayEnvelope.rootMessageID,
        finish: "length",
      },
      parts: [
        {
          id: "assistant-structured-tool-running",
          sessionID: replayEnvelope.sessionID,
          messageID: "assistant-structured-running",
          type: "tool",
          tool: "StructuredOutput",
          state: {
            status: "running",
            input: { answer: "par" },
            title: "Structured Output",
            metadata: {},
            time: { start: 1 },
          },
        },
      ],
    },
  ]
}

function createStructuredOutputErrorHistory(replayEnvelope: ReplayEnvelope) {
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
        id: "assistant-structured-error",
        sessionID: replayEnvelope.sessionID,
        role: "assistant",
        parentID: replayEnvelope.rootMessageID,
        finish: "stop",
        error: {
          name: "StructuredOutputError",
          message: "Model did not produce structured output",
          retries: 0,
        },
      },
      parts: [],
    },
  ]
}

describe("structured output handling", () => {
  test("treats StructuredOutput tool states as safe for side-effect classification", () => {
    const completedTool = classifyCompletedToolExecution({ tool: "StructuredOutput" })

    expect(completedTool.classification).toBe("read-only")
    expect(completedTool.blocksAutoRetry).toBe(false)
    expect(completedTool.reason).toBe("structured-output-tool")

    for (const state of [
      { status: "pending" },
      { status: "running" },
      { status: "completed" },
      { status: "error", error: "schema validation failed" },
    ]) {
      const assessment = classifyMessagePartSideEffect({
        type: "tool",
        tool: "StructuredOutput",
        state,
      })

      expect(assessment).toBeDefined()
      expect(assessment?.classification).toBe("read-only")
      expect(assessment?.blocksAutoRetry).toBe(false)
      expect(assessment?.reason).toBe("structured-output-tool")
    }
  })

  test("ignores completed structured output without replaying", async () => {
    const sessionID = "session-structured-complete"
    const rootMessageID = "root-structured-complete"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    let revertCalls = 0
    let promptCalls = 0

    const result = await attemptSafeReplayTransaction({
      client: {
        session: {
          async messages() {
            return { data: structuredClone(createStructuredOutputCompleteHistory(replayEnvelope)) }
          },
          async status() {
            return { data: {} }
          },
          async revert() {
            revertCalls += 1
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
      replayClientFactory: () => ({
        session: {
          async prompt() {
            promptCalls += 1
            return { data: true }
          },
        },
      }),
    })

    expect(result).toEqual({ outcome: "ignored", reason: "structured-output-complete" })
    expect(revertCalls).toBe(0)
    expect(promptCalls).toBe(0)
  })

  test("retries a truncated turn while StructuredOutput is still running", async () => {
    const sessionID = "session-structured-running"
    const rootMessageID = "root-structured-running"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    const revertCalls: Array<{ path: { id: string }; body: { messageID: string } }> = []
    let promptCalls = 0

    const result = await attemptSafeReplayTransaction({
      client: {
        session: {
          async messages() {
            return { data: structuredClone(createStructuredOutputRunningTruncatedHistory(replayEnvelope)) }
          },
          async status() {
            return { data: {} }
          },
          async revert(input: { path: { id: string }; body: { messageID: string } }) {
            revertCalls.push(input)
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
      replayClientFactory: () => ({
        session: {
          async prompt() {
            promptCalls += 1
            return { data: true }
          },
        },
      }),
    })

    expect(result).toEqual({ outcome: "replayed", retryCount: 1 })
    expect(revertCalls).toEqual([
      {
        path: { id: sessionID },
        body: { messageID: rootMessageID },
      },
    ])
    expect(promptCalls).toBe(1)
  })

  test("ignores StructuredOutputError instead of replaying it as truncation", async () => {
    const sessionID = "session-structured-error"
    const rootMessageID = "root-structured-error"
    const tracker = createSessionTracker()
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    const start = tracker.startTurn({ sessionID, replayEnvelope })
    let revertCalls = 0
    let promptCalls = 0

    const result = await attemptSafeReplayTransaction({
      client: {
        session: {
          async messages() {
            return { data: structuredClone(createStructuredOutputErrorHistory(replayEnvelope)) }
          },
          async status() {
            return { data: {} }
          },
          async revert() {
            revertCalls += 1
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
      replayClientFactory: () => ({
        session: {
          async prompt() {
            promptCalls += 1
            return { data: true }
          },
        },
      }),
    })

    expect(result).toEqual({ outcome: "ignored", reason: "structured-output-error" })
    expect(revertCalls).toBe(0)
    expect(promptCalls).toBe(0)
  })

  test("cleans up session tracking after structured output completes", async () => {
    const sessionID = "session-structured-cleanup"
    const rootMessageID = "root-structured-cleanup"
    const replayEnvelope = createReplayEnvelope(sessionID, rootMessageID)
    let messagesCallCount = 0

    const hooks = createTruncationRetryHooks(
      {
        client: {
          session: {
            async messages() {
              messagesCallCount += 1
              return { data: structuredClone(createStructuredOutputCompleteHistory(replayEnvelope)) }
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
  })
})
