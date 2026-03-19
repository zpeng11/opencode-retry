import { describe, expect, test } from "bun:test"

import { appendEscalationWarningToAssistantText, escalateToUserJudgment } from "../src/escalation.js"
import { createTruncationRetryHooks, type PluginInput } from "../src/index.js"
import { createSessionTracker } from "../src/tracker.js"
import type { PluginConfig, ReplayEnvelope } from "../src/types.js"

function createEnabledConfig(): PluginConfig {
  return {
    enabled: true,
    classifierTimeoutMs: 500,
    maxRetries: 2,
  }
}

function createReplayEnvelope(sessionID: string, rootMessageID: string): ReplayEnvelope {
  return {
    sessionID,
    rootMessageID,
    parts: [{ type: "text", text: "Retry safely." }],
  }
}

describe("transcript warning", () => {
  test("appends the escalation warning to the latest assistant text without any UI fallback", async () => {
    const tracker = createSessionTracker()
    const sessionID = "session-transcript-warning"
    const start = tracker.startTurn({
      sessionID,
      replayEnvelope: createReplayEnvelope(sessionID, "root-transcript-warning"),
    })
    const partUpdateCalls: Array<{
      sessionID: string
      messageID: string
      partID: string
      directory?: string
      part?: unknown
    }> = []

    await escalateToUserJudgment({
      client: {
        session: {
          async messages() {
            return {
              data: [
                {
                  info: {
                    id: "assistant-warning-message",
                    role: "assistant",
                  },
                  parts: [
                    {
                      id: "assistant-warning-part",
                      sessionID,
                      messageID: "assistant-warning-message",
                      type: "text",
                      text: "Partial answer",
                    },
                  ],
                },
              ],
            }
          },
        },
      },
      tracker,
      sessionID,
      generation: start.generation,
      reason: "unsafe-turn",
      directory: "/tmp/opencode-retry",
      serverUrl: new URL("http://127.0.0.1:4096"),
      warningClientFactory: () => ({
        part: {
          async update(input) {
            partUpdateCalls.push(input)
            return { data: true }
          },
        },
      }),
    })

    expect(partUpdateCalls).toHaveLength(1)
    expect(partUpdateCalls[0]).toMatchObject({
      sessionID,
      messageID: "assistant-warning-message",
      partID: "assistant-warning-part",
      directory: "/tmp/opencode-retry",
    })
    expect(partUpdateCalls[0]?.part).toMatchObject({
      text: appendEscalationWarningToAssistantText("Partial answer", "unsafe-turn"),
      metadata: {
        opencodeRetryEscalationWarningReason: "unsafe-turn",
      },
    })
  })

  test("strips transcript warnings before model submission", async () => {
    const hooks = createTruncationRetryHooks(
      {
        client: {} as PluginInput["client"],
      },
      {
        config: createEnabledConfig(),
      },
    )

    const assistantText = appendEscalationWarningToAssistantText("Partial answer", "classifier-truncated")
    const messages = [
      {
        info: {
          id: "assistant-warning-message",
          role: "assistant",
        },
        parts: [
          {
            id: "assistant-warning-part",
            sessionID: "session-transform",
            messageID: "assistant-warning-message",
            type: "text",
            text: assistantText,
            metadata: {
              opencodeRetryEscalationWarningReason: "classifier-truncated",
            },
          },
        ],
      },
    ]

    await hooks["experimental.chat.messages.transform"]?.({} as never, { messages } as never)

    expect((messages[0]?.parts[0] as { text?: string })?.text).toBe("Partial answer")
  })
})
