import { describe, expect, test } from "bun:test"

import { assessSideEffects, classifyMessagePartSideEffect } from "../src/side-effects.js"

describe("patch parts unsafe", () => {
  test("treats any patch emission as mutating and retry-blocking", () => {
    const assessment = classifyMessagePartSideEffect({
      type: "patch",
      files: ["src/side-effects.ts"],
    })

    expect(assessment).toBeDefined()
    expect(assessment?.classification).toBe("mutating")
    expect(assessment?.blocksAutoRetry).toBe(true)
    expect(assessment?.reason).toBe("patch-part")
  })

  test("treats any tool error as unsafe for auto-retry", () => {
    const assessment = classifyMessagePartSideEffect({
      type: "tool",
      tool: "read",
      state: {
        status: "error",
        error: "network failure",
      },
    })

    expect(assessment).toBeDefined()
    expect(assessment?.classification).toBe("unsafe-unknown")
    expect(assessment?.blocksAutoRetry).toBe(true)
    expect(assessment?.reason).toBe("tool-error")
  })

  test("patch parts still block optimistic retry after step-finish appears first", () => {
    const summary = assessSideEffects({
      completedTools: [{ tool: "read" }],
      parts: [
        { type: "step-finish" },
        { type: "patch", files: ["src/side-effects.ts"] },
      ],
    })

    expect(summary.classification).toBe("mutating")
    expect(summary.blocksAutoRetry).toBe(true)
    expect(summary.reasons).toEqual(["known-read-only-tool", "patch-part"])
  })

  test("tool errors keep the turn unsafe even when read-only tools completed earlier", () => {
    const summary = assessSideEffects({
      completedTools: [{ tool: "glob" }],
      parts: [
        {
          type: "tool",
          tool: "grep",
          state: {
            status: "error",
            error: "timed out",
          },
        },
      ],
    })

    expect(summary.classification).toBe("unsafe-unknown")
    expect(summary.blocksAutoRetry).toBe(true)
    expect(summary.reasons).toEqual(["known-read-only-tool", "tool-error"])
  })
})
