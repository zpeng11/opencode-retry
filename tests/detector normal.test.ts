import { describe, expect, test } from "bun:test"

import { detectTruncation } from "../src/detector.js"

describe("detector normal", () => {
  test("keeps a naturally finished short answer normal", () => {
    const result = detectTruncation({
      lastAssistantText: "The build is green.",
      finishReason: "stop",
    })

    expect(result.decision).toBe("normal")
    expect(result.finishReason).toBe("stop")
    expect(result.finishError).toBeUndefined()
  })

  test("does not over-classify a terse finished reply without punctuation", () => {
    const result = detectTruncation({
      lastAssistantText: "Done",
    })

    expect(result.decision).toBe("normal")
  })

  test("keeps dangling phrasing out of the normal path", () => {
    const result = detectTruncation({
      lastAssistantText: "The next step is to",
      finishReason: "stop",
    })

    expect(result.decision).toBe("needs-classifier")
  })
})
