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

function createChatMessageArgs(sessionID: string, rootMessageID: string) {
  return {
    hookInput: {
      sessionID,
      agent: "dedupe-agent",
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
        agent: "dedupe-agent",
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

describe("idle dedupe", () => {
  test("dedupes duplicate idle notifications and ignores deprecated session.idle events", async () => {
    const sessionID = "session-idle"
    const rootMessageID = "root-1"
    const fetchStarted = deferred<void>()
    const releaseFetch = deferred<void>()
    const idleSnapshot = deferred<IdleSnapshot>()
    const requestedIDs: string[] = []
    let messagesCallCount = 0
    let idleSnapshotCount = 0

    const hooks = createTruncationRetryHooks(
      {
        client: {
          session: {
            async messages(input: { path: { id: string } }) {
              requestedIDs.push(input.path.id)
              messagesCallCount += 1
              fetchStarted.resolve()
              await releaseFetch.promise
              return { data: [{ info: { id: rootMessageID, role: "user" }, parts: [] }] }
            },
          },
        } as unknown as PluginInput["client"],
      },
      {
        config: createEnabledConfig(),
        onIdleSnapshot: (snapshot) => {
          idleSnapshotCount += 1
          idleSnapshot.resolve(snapshot)
        },
      },
    )

    const { hookInput, hookOutput } = createChatMessageArgs(sessionID, rootMessageID)
    await hooks["chat.message"]?.(hookInput as never, hookOutput as never)

    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await fetchStarted.promise

    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID },
      } as never,
    })

    expect(messagesCallCount).toBe(1)
    expect(requestedIDs).toEqual([sessionID])

    releaseFetch.resolve()
    await idleSnapshot.promise

    expect(idleSnapshotCount).toBe(1)

    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await Promise.resolve()

    expect(messagesCallCount).toBe(1)
    expect(idleSnapshotCount).toBe(1)
    expect(requestedIDs).toEqual([sessionID])
  })
})
