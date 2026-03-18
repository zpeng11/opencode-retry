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
      agent: "generation-agent",
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
        agent: "generation-agent",
        model: { providerID: "openai", modelID: "gpt-4o" },
        system: "Stay concise.",
      } as unknown,
      parts: [
        {
          id: `part-${rootMessageID}`,
          sessionID,
          messageID: rootMessageID,
          type: "text",
          text: `prompt:${rootMessageID}`,
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

describe("stale generation ignored", () => {
  test("ignores idle work from an older generation after a newer prompt starts", async () => {
    const sessionID = "session-stale"
    const firstFetchStarted = deferred<void>()
    const releaseFirstFetch = deferred<void>()
    const currentIdleSnapshot = deferred<IdleSnapshot>()
    const receivedSnapshots: IdleSnapshot[] = []
    const requestedIDs: string[] = []
    let messagesCallCount = 0

    const hooks = createTruncationRetryHooks(
      {
        client: {
          session: {
            async messages(input: { path: { id: string } }) {
              requestedIDs.push(input.path.id)
              messagesCallCount += 1

              if (messagesCallCount === 1) {
                firstFetchStarted.resolve()
                await releaseFirstFetch.promise
                return { data: [{ info: { id: "root-1", role: "user" }, parts: [] }] }
              }

              return { data: [{ info: { id: "root-2", role: "user" }, parts: [] }] }
            },
          },
        } as unknown as PluginInput["client"],
      },
      {
        config: createEnabledConfig(),
        onIdleSnapshot: (snapshot) => {
          receivedSnapshots.push(snapshot)
          currentIdleSnapshot.resolve(snapshot)
        },
      },
    )

    const firstTurn = createChatMessageArgs(sessionID, "root-1")
    await hooks["chat.message"]?.(firstTurn.hookInput as never, firstTurn.hookOutput as never)
    await hooks.event?.({ event: createIdleEvent(sessionID) as never })
    await firstFetchStarted.promise

    const secondTurn = createChatMessageArgs(sessionID, "root-2")
    await hooks["chat.message"]?.(secondTurn.hookInput as never, secondTurn.hookOutput as never)

    releaseFirstFetch.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(receivedSnapshots).toHaveLength(0)

    await hooks.event?.({ event: createIdleEvent(sessionID) as never })

    const snapshot = await currentIdleSnapshot.promise

    expect(messagesCallCount).toBe(2)
    expect(requestedIDs).toEqual([sessionID, sessionID])
    expect(receivedSnapshots).toHaveLength(1)
    expect(snapshot.generation).toBe(2)
    expect(snapshot.tracker.rootMessageID).toBe("root-2")
    expect(snapshot.messages).toEqual([{ info: { id: "root-2", role: "user" }, parts: [] }])
  })
})
