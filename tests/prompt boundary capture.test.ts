import { describe, expect, test } from "bun:test"

import { createTruncationRetryHooks, type IdleSnapshot, type PluginInput } from "../src/index.js"
import type { PluginConfig } from "../src/types.js"

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

function createFakeClient(messages: unknown[], onMessages?: (sessionID: string) => void): PluginInput["client"] {
  return {
    session: {
      async messages(input: { path: { id: string } }) {
        onMessages?.(input.path.id)
        return { data: messages }
      },
    },
  } as unknown as PluginInput["client"]
}

function createChatMessageArgs(sessionID: string, rootMessageID: string) {
  const model = { providerID: "openai", modelID: "gpt-4o" }
  const format = { type: "json_schema", schema: { type: "object", additionalProperties: false } }
  const parts = [
    {
      id: "part-user-1",
      sessionID,
      messageID: rootMessageID,
      type: "text",
      text: "Finish this safely.",
    },
  ]

  return {
    hookInput: {
      sessionID,
      agent: "capturing-agent",
      model,
      messageID: rootMessageID,
      variant: "cli-default",
    },
    hookOutput: {
      message: {
        id: rootMessageID,
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "capturing-agent",
        model,
        system: "Stay concise.",
        format,
        variant: "cli-default",
      } as unknown,
      parts: parts as unknown[],
    },
    expectedReplayEnvelope: {
      sessionID,
      rootMessageID,
      parts,
      agent: "capturing-agent",
      model,
      system: "Stay concise.",
      format,
      variant: "cli-default",
    },
  }
}

describe("prompt boundary capture", () => {
  test("captures the prompt boundary and successful tool outcomes for idle snapshots", async () => {
    const sessionID = "session-capture"
    const rootMessageID = "root-1"
    const idleSnapshot = deferred<IdleSnapshot>()
    const requestedSessions: string[] = []
    const messageHistory = [{ info: { id: rootMessageID, role: "user" }, parts: [] }]
    const { hookInput, hookOutput, expectedReplayEnvelope } = createChatMessageArgs(sessionID, rootMessageID)

    const hooks = createTruncationRetryHooks(
      { client: createFakeClient(messageHistory, (currentSessionID) => requestedSessions.push(currentSessionID)) },
      {
        config: createEnabledConfig(),
        onIdleSnapshot: (snapshot) => {
          idleSnapshot.resolve(snapshot)
        },
      },
    )

    await hooks["chat.message"]?.(hookInput as never, hookOutput as never)
    await hooks["tool.execute.after"]?.(
      { tool: "read", sessionID, callID: "call-1", args: {} },
      { title: "Read", output: "ok", metadata: {} },
    )
    await hooks["tool.execute.after"]?.(
      { tool: "write", sessionID, callID: "call-2", args: {} },
      { title: "Write", output: "ok", metadata: {} },
    )

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: { type: "idle" },
        },
      } as never,
    })

    const snapshot = await idleSnapshot.promise

    expect(requestedSessions).toEqual([sessionID])
    expect(snapshot.generation).toBe(1)
    expect(snapshot.tracker.pendingIdleGeneration).toBe(1)
    expect(snapshot.tracker.replayEnvelope).toEqual(expectedReplayEnvelope as never)
    expect(snapshot.recentToolOutcomes).toEqual([
      { toolName: "read", success: true, toolArgs: {} },
      { toolName: "write", success: true, toolArgs: {} },
    ])
    expect(snapshot.messages).toEqual(messageHistory)
  })
})
