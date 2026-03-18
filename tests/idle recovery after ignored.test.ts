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
    classifierEndpoint: "https://example.com/v1/chat/completions",
    classifierModel: "gpt-4o-mini",
    classifierApiKey: "test-key",
    classifierTimeoutMs: 500,
    maxRetries: 2,
  }
}

function createChatMessageArgs(sessionID: string, rootMessageID: string) {
  return {
    hookInput: {
      sessionID,
      agent: "recovery-agent",
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
        agent: "recovery-agent",
        model: { providerID: "openai", modelID: "gpt-4o" },
        system: "Stay concise.",
      } as unknown,
      parts: [
        {
          id: "part-user-1",
          sessionID,
          messageID: rootMessageID,
          type: "text",
          text: "Inspect the files.",
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

describe("idle recovery after ignored", () => {
  test("clears pending idle when first idle returns ignored, allowing second idle to succeed", async () => {
    const sessionID = "session-idle-recovery"
    const rootMessageID = "root-recovery-1"
    const firstStatusReturned = deferred<void>()
    const allowSecondStatus = deferred<void>()
    const firstSnapshotCalled = deferred<void>()
    const secondSnapshotCalled = deferred<void>()
    let statusCallCount = 0
    let snapshotCount = 0
    const callLog: string[] = []

    const hooks = createTruncationRetryHooks(
      {
        client: {
          session: {
            async messages(input: { path: { id: string } }) {
              callLog.push("messages called")
              return { data: [{ info: { id: rootMessageID, role: "user" }, parts: [] }] }
            },
            async status() {
              statusCallCount += 1
              callLog.push(`status call #${statusCallCount}`)
              if (statusCallCount === 1) {
                firstStatusReturned.resolve()
                callLog.push("returning busy")
                return { data: { [sessionID]: { type: "busy" } } }
              }
              callLog.push("waiting for allowSecondStatus")
              await allowSecondStatus.promise
              callLog.push("returning idle")
              return { data: {} }
            },
          },
        } as unknown as PluginInput["client"],
      },
      {
        config: createEnabledConfig(),
        onIdleSnapshot: async () => {
          snapshotCount += 1
          callLog.push(`snapshot call #${snapshotCount}`)
          if (snapshotCount === 1) {
            firstSnapshotCalled.resolve()
          } else if (snapshotCount === 2) {
            secondSnapshotCalled.resolve()
          }
        },
      },
    )

    const { hookInput, hookOutput } = createChatMessageArgs(sessionID, rootMessageID)
    await hooks["chat.message"]?.(hookInput as never, hookOutput as never)

    callLog.push("sending first idle event")
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    callLog.push("waiting for first status")
    await firstStatusReturned.promise
    callLog.push("waiting for first snapshot")
    await firstSnapshotCalled.promise

    expect(statusCallCount).toBe(1)
    expect(snapshotCount).toBe(1)

    callLog.push("resolving allowSecondStatus")
    allowSecondStatus.resolve()
    await Promise.resolve()

    callLog.push("sending second idle event")
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    callLog.push("waiting for second snapshot (with timeout)")
    const secondSnapshotResult = await Promise.race([
      secondSnapshotCalled.promise.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ])

    callLog.push(`second snapshot result: ${secondSnapshotResult}`)

    expect(statusCallCount).toBe(2)
    expect(snapshotCount).toBe(2)
  })
})
