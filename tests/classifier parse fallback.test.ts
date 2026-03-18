import { describe, expect, test } from "bun:test"

import { classifyWithSmallModel } from "../src/classifier.js"
import { ClassifierResult, type ClassifierPayload } from "../src/types.js"

function createPayload(): ClassifierPayload {
  return {
    rootPrompt: [{ type: "text", text: "Did the assistant get cut off?" }],
    lastAssistantText: "The answer may have cut off",
    finishReason: "stop",
    recentToolOutcomes: [],
    retryCount: 1,
  }
}

function createResponseFetch(response: Response): typeof fetch {
  return (async () => response) as typeof fetch
}

function createThrowingFetch(error: Error): typeof fetch {
  return (async () => {
    throw error
  }) as typeof fetch
}

function createConfig() {
  return {
    classifierEndpoint: "https://example.com/v1/chat/completions",
    classifierModel: "gpt-4o-mini",
    classifierApiKey: "test-key",
    classifierTimeoutMs: 500,
  }
}

describe("classifier parse fallback", () => {
  test("falls back when the top-level response is malformed", async () => {
    const result = await classifyWithSmallModel({
      config: createConfig(),
      payload: createPayload(),
      fetch: createResponseFetch(
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    })

    expect(result).toEqual({
      result: ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT,
      failure: "Classifier response did not include a chat completion choice.",
    })
  })

  test("falls back when the classifier message content is not valid JSON", async () => {
    const result = await classifyWithSmallModel({
      config: createConfig(),
      payload: createPayload(),
      fetch: createResponseFetch(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "not-json" } }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    })

    expect(result).toEqual({
      result: ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT,
      failure: "Classifier message content was not valid JSON.",
    })
  })

  test("falls back when the classifier returns an invalid enum value", async () => {
    const result = await classifyWithSmallModel({
      config: createConfig(),
      payload: createPayload(),
      fetch: createResponseFetch(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ result: "definitely-truncated" }) } }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    })

    expect(result).toEqual({
      result: ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT,
      failure: "Classifier result was invalid: definitely-truncated.",
    })
  })

  test("surfaces non-ok response details while falling back safely", async () => {
    const result = await classifyWithSmallModel({
      config: createConfig(),
      payload: createPayload(),
      fetch: createResponseFetch(
        new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    })

    expect(result.result).toBe(ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT)
    expect(result.failure).toContain("Classifier request failed with 502 Bad Gateway")
    expect(result.failure).toContain("upstream unavailable")
  })

  test("surfaces thrown fetch errors while falling back safely", async () => {
    const result = await classifyWithSmallModel({
      config: createConfig(),
      payload: createPayload(),
      fetch: createThrowingFetch(new Error("socket hang up")),
    })

    expect(result).toEqual({
      result: ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT,
      failure: "Classifier request failed: Error: socket hang up",
    })
  })
})
