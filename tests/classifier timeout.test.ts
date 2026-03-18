import { describe, expect, test } from "bun:test"

import { classifyWithSmallModel } from "../src/classifier.js"
import { ClassifierResult, type ClassifierPayload } from "../src/types.js"

function createPayload(): ClassifierPayload {
  return {
    rootPrompt: [{ type: "text", text: "Check the last assistant turn." }],
    lastAssistantText: "The answer trails off",
    finishReason: "stop",
    recentToolOutcomes: [],
    retryCount: 0,
  }
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  return error
}

function createStalledFetch(onAbort: () => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = input instanceof Request ? input.signal : init?.signal
    if (!signal) {
      throw new Error("Expected fetch signal")
    }

    return await new Promise<Response>((_, reject) => {
      const abort = () => {
        onAbort()
        reject(createAbortError())
      }

      if (signal.aborted) {
        abort()
        return
      }

      signal.addEventListener("abort", abort, { once: true })
    })
  }) as typeof fetch
}

describe("classifier timeout", () => {
  test("falls back safely when the classifier fetch exceeds the timeout", async () => {
    let abortCount = 0

    const result = await classifyWithSmallModel({
      config: {
        classifierEndpoint: "https://example.com/v1/chat/completions",
        classifierModel: "gpt-4o-mini",
        classifierApiKey: "test-key",
        classifierTimeoutMs: 100,
      },
      payload: createPayload(),
      fetch: createStalledFetch(() => {
        abortCount += 1
      }),
    })

    expect(abortCount).toBe(1)
    expect(result).toEqual({
      result: ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT,
      failure: "Classifier request timed out after 100ms.",
    })
  })
})
