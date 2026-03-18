import { describe, expect, test } from "bun:test"

import {
  assessSideEffects,
  classifyCompletedToolExecution,
  classifyToolPartSideEffect,
} from "../src/side-effects.js"

describe("side effects", () => {
  test("keeps known read-only tools safe for auto-retry", () => {
    for (const tool of ["read", "glob", "grep", "list", "lsp", "todoread", "codesearch", "webfetch", "websearch"]) {
      const assessment = classifyCompletedToolExecution({ tool })

      expect(assessment.classification).toBe("read-only")
      expect(assessment.blocksAutoRetry).toBe(false)
      expect(assessment.reason).toBe("known-read-only-tool")
    }
  })

  test("blocks known mutating tools after successful execution", () => {
    for (const tool of ["write", "edit", "multiEdit"]) {
      const assessment = classifyCompletedToolExecution({ tool })

      expect(assessment.classification).toBe("mutating")
      expect(assessment.blocksAutoRetry).toBe(true)
      expect(assessment.reason).toBe("known-mutating-tool")
    }
  })

  test("allows a narrow set of completed read-only bash commands", () => {
    for (const command of ["pwd", "ls -la", "git status --short", "rg TODO src", "sed -n '1,20p' README.md", "head -n 5 README.md", "tail -n 5 README.md"]) {
      const assessment = classifyCompletedToolExecution({
        tool: "bash",
        args: { command },
      })

      expect(assessment.classification).toBe("read-only")
      expect(assessment.blocksAutoRetry).toBe(false)
      expect(assessment.reason).toBe("read-only-bash-command")
    }
  })

  test("keeps unrecognized or write-capable bash commands conservative", () => {
    for (const command of ["npm test", "echo hi > out.txt", "pwd && ls", "sed -i 's/a/b/' file.txt", "git commit -m test"]) {
      const assessment = classifyCompletedToolExecution({
        tool: "bash",
        args: { command },
      })

      expect(assessment.classification).toBe("unsafe-unknown")
      expect(assessment.blocksAutoRetry).toBe(true)
      expect(assessment.reason).toBe("unsafe-bash-command")
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

  test("keeps session-mutating or delegated tools conservative until explicitly modeled", () => {
    for (const tool of ["task", "todowrite"]) {
      const assessment = classifyCompletedToolExecution({ tool })

      expect(assessment.classification).toBe("unsafe-unknown")
      expect(assessment.blocksAutoRetry).toBe(true)
    }
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

  test("requires a completed tool state before trusting bash command classification", () => {
    const completed = classifyToolPartSideEffect({
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: {
          command: "git status --short",
        },
      },
    })

    expect(completed.classification).toBe("read-only")
    expect(completed.blocksAutoRetry).toBe(false)
    expect(completed.reason).toBe("read-only-bash-command")

    const failed = classifyToolPartSideEffect({
      type: "tool",
      tool: "bash",
      state: {
        status: "error",
        input: {
          command: "git status --short",
        },
        error: "git failed",
      },
    })

    expect(failed.classification).toBe("unsafe-unknown")
    expect(failed.blocksAutoRetry).toBe(true)
    expect(failed.reason).toBe("tool-error")
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
