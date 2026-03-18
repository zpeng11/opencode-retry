import { describe, expect, test } from "bun:test"

import { classifyWithSmallModel } from "../src/classifier.js"
import { CLASSIFIER_SYSTEM_PROMPT } from "../src/config.js"
import { ClassifierResult, type ClassifierPayload } from "../src/types.js"

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function createPayload(): ClassifierPayload {
  return {
    rootPrompt: [{ type: "text", text: "Finish the reply safely." }],
    lastAssistantText: "The answer stops halfway through",
    finishReason: "stop",
    recentToolOutcomes: [{ toolName: "read", success: true }],
    retryCount: 1,
  }
}

describe("classifier success", () => {
  test("sends a direct chat completion request and returns the validated result", async () => {
    const payload = createPayload()
    const pendingRequest = deferred<Capture>()
    const fetchStub = (async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const body = (await request.json()) as Record<string, unknown>
      pendingRequest.resolve({ url, headers: request.headers, body })

      if (url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 })
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ result: ClassifierResult.TRUNCATED }) } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      )
    }) as typeof fetch

    const resultPromise = classifyWithSmallModel({
      config: {
        classifierEndpoint: "https://example.com/v1/chat/completions",
        classifierModel: "gpt-4o-mini",
        classifierApiKey: "test-key",
        classifierTimeoutMs: 500,
      },
      payload,
      fetch: fetchStub,
    })

    const capture = await pendingRequest.promise
    const result = await resultPromise

    expect(result).toEqual({ result: ClassifierResult.TRUNCATED })
    expect(capture.url.pathname).toBe("/v1/chat/completions")
    expect(capture.headers.get("authorization")).toBe("Bearer test-key")
    expect(capture.headers.get("content-type")).toContain("application/json")
    expect(capture.body).toEqual({
      model: "gpt-4o-mini",
      temperature: 0,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
    })
  })
})
