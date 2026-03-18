import { describe, expect, test } from "bun:test"

import { detectTruncation } from "../src/detector.js"

describe("detector truncated", () => {
  test("marks a length finish reason as truncated immediately", () => {
    const result = detectTruncation({
      lastAssistantText: "This answer looks complete.",
      finishReason: "length",
    })

    expect(result.decision).toBe("truncated")
    expect(result.finishReason).toBe("length")
  })

  test("marks a known output-length error as truncated immediately", () => {
    const result = detectTruncation({
      lastAssistantText: "Final sentence.",
      finishError: {
        name: "MessageOutputLengthError",
        data: {},
      },
    })

    expect(result.decision).toBe("truncated")
    expect(result.finishError).toBe("MessageOutputLengthError")
  })

  test("treats output length wording as truncated even without a structured error", () => {
    const result = detectTruncation({
      lastAssistantText: "Final sentence.",
      finishError: "provider reported output length exceeded",
    })

    expect(result.decision).toBe("truncated")
  })
})
