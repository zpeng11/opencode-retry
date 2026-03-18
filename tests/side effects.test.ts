import { describe, expect, test } from "bun:test"

import {
  assessSideEffects,
  classifyCompletedToolExecution,
  classifyToolPartSideEffect,
} from "../src/side-effects.js"

describe("side effects", () => {
  test("keeps known read-only tools safe for auto-retry", () => {
    for (const tool of ["read", "glob", "grep"]) {
      const assessment = classifyCompletedToolExecution({ tool })

      expect(assessment.classification).toBe("read-only")
      expect(assessment.blocksAutoRetry).toBe(false)
      expect(assessment.reason).toBe("known-read-only-tool")
    }
  })

  test("blocks known mutating tools after successful execution", () => {
    for (const tool of ["write", "edit", "multiEdit", "bash"]) {
      const assessment = classifyCompletedToolExecution({ tool })

      expect(assessment.classification).toBe("mutating")
      expect(assessment.blocksAutoRetry).toBe(true)
      expect(assessment.reason).toBe("known-mutating-tool")
    }
  })

  test("blocks unknown tools conservatively", () => {
    const writeLike = classifyCompletedToolExecution({ tool: "writeFile" })
    expect(writeLike.classification).toBe("unsafe-unknown")
    expect(writeLike.blocksAutoRetry).toBe(true)
    expect(writeLike.reason).toBe("write-like-or-execute-like-tool")

    const executeLike = classifyCompletedToolExecution({ tool: "runTask" })
    expect(executeLike.classification).toBe("unsafe-unknown")
    expect(executeLike.blocksAutoRetry).toBe(true)
    expect(executeLike.reason).toBe("write-like-or-execute-like-tool")

    const unknown = classifyCompletedToolExecution({ tool: "searchWeb" })
    expect(unknown.classification).toBe("unsafe-unknown")
    expect(unknown.blocksAutoRetry).toBe(true)
    expect(unknown.reason).toBe("unknown-tool")
  })

  test("treats missing tool state as unsafe instead of inferring safety from the name", () => {
    const assessment = classifyToolPartSideEffect({
      type: "tool",
      tool: "read",
    })

    expect(assessment.classification).toBe("unsafe-unknown")
    expect(assessment.blocksAutoRetry).toBe(true)
    expect(assessment.reason).toBe("missing-tool-state")
  })

  test("summarizes mixed tool outcomes conservatively", () => {
    const summary = assessSideEffects({
      completedTools: [{ tool: "read" }, { tool: "searchWeb" }],
    })

    expect(summary.classification).toBe("unsafe-unknown")
    expect(summary.blocksAutoRetry).toBe(true)
    expect(summary.reasons).toEqual(["known-read-only-tool", "unknown-tool"])
  })
})
