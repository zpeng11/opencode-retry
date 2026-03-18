import { describe, expect, test } from "bun:test"

import { buildClassifierPayload } from "../src/detector.js"
import type { ReplayEnvelope } from "../src/types.js"

function createReplayEnvelope(): ReplayEnvelope {
  return {
    sessionID: "session-1",
    rootMessageID: "root-1",
    parts: [
      {
        type: "text",
        text: "A".repeat(400),
        extra: {
          zebra: "keep me sorted last",
          alpha: "keep me sorted first",
          nested: {
            text: "B".repeat(400),
            array: ["one", "two", "three", "four", "five"],
          },
        },
      },
      { type: "image", url: "https://example.com/asset.png" },
      { type: "text", text: "third part" },
      { type: "text", text: "fourth part" },
      { type: "text", text: "fifth part should be dropped" },
    ],
    agent: "agent-name",
    model: "model-name",
    system: "S".repeat(300),
    format: "markdown",
    variant: "default",
  }
}

describe("classifier payload", () => {
  test("builds a bounded payload from recent context", () => {
    const payload = buildClassifierPayload({
      replayEnvelope: createReplayEnvelope(),
      lastAssistantText: "0123456789".repeat(250),
      finishReason: "stop",
      finishError: {
        name: "UnknownError",
        data: { message: "Network hop failed unexpectedly." },
      },
      recentToolOutcomes: [
        { toolName: "read", success: true },
        { toolName: "glob", success: true },
        { toolName: "grep", success: true },
        {
          toolName: "bash",
          success: false,
          errorMessage: "E".repeat(220),
        },
      ],
      recentToolOutcomeWindow: 2,
      retryCount: 2,
    })

    expect(payload.rootPrompt).toHaveLength(4)
    expect(payload.rootPrompt[0]).toEqual({
      extra: {
        alpha: "keep me sorted first",
        nested: {
          array: ["one", "two", "three", "four"],
          text: `${"B".repeat(237)}...`,
        },
        zebra: "keep me sorted last",
      },
      text: `${"A".repeat(237)}...`,
      type: "text",
    })
    expect(payload.lastAssistantText.startsWith("...")).toBe(true)
    expect(payload.lastAssistantText).toHaveLength(1600)
    expect(payload.finishError).toBe("UnknownError: Network hop failed unexpectedly.")
    expect(payload.recentToolOutcomes).toEqual([
      { toolName: "grep", success: true, errorMessage: undefined },
      { toolName: "bash", success: false, errorMessage: `${"E".repeat(157)}...` },
    ])
    expect(payload.retryCount).toBe(2)
  })

  test("is deterministic for the same inputs", () => {
    const input = {
      replayEnvelope: createReplayEnvelope(),
      lastAssistantText: "Completed successfully.",
      finishReason: "stop",
      recentToolOutcomes: [
        { toolName: "read", success: true },
        { toolName: "glob", success: true },
      ],
      retryCount: 1,
    } as const

    const first = buildClassifierPayload(input)
    const second = buildClassifierPayload(input)

    expect(second).toEqual(first)
  })
})
