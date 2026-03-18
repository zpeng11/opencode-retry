import { describe, test, expect } from "bun:test"
import type { SessionState, ClassifierPayload, ReplayEnvelope, PluginConfig } from "../src/types.js"
import { ClassifierResult } from "../src/types.js"

describe("state types", () => {
  test("ClassifierResult enum has all required values", () => {
    expect(ClassifierResult.NORMAL).toBe(ClassifierResult.NORMAL)
    expect(ClassifierResult.TRUNCATED).toBe(ClassifierResult.TRUNCATED)
    expect(ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT).toBe(ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT)
    
    const normal: string = ClassifierResult.NORMAL
    const truncated: string = ClassifierResult.TRUNCATED
    const maybe: string = ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT
    
    expect(normal).toBe("normal")
    expect(truncated).toBe("truncated")
    expect(maybe).toBe("maybe-truncated-needs-judgment")
  })

  test("SessionState can be initialized with required fields", () => {
    const state: SessionState = {
      generation: 1,
      retryCount: 0,
      isEscalated: false,
    }

    expect(state.generation).toBe(1)
    expect(state.retryCount).toBe(0)
    expect(state.isEscalated).toBe(false)
    expect(state.rootMessageID).toBeUndefined()
    expect(state.replayEnvelope).toBeUndefined()
    expect(state.pendingIdleGeneration).toBeUndefined()
  })

  test("SessionState can include optional fields", () => {
    const envelope: ReplayEnvelope = {
      sessionID: "sess-123",
      rootMessageID: "msg-456",
      parts: ["test"],
      agent: "claude-opus",
      model: "claude-3.5-sonnet",
      system: "You are helpful",
      format: "markdown",
      variant: "v1",
    }

    const state: SessionState = {
      generation: 2,
      rootMessageID: "msg-456",
      replayEnvelope: envelope,
      retryCount: 1,
      isEscalated: false,
      pendingIdleGeneration: 2,
    }

    expect(state.replayEnvelope).toEqual(envelope)
    expect(state.pendingIdleGeneration).toBe(2)
  })

  test("ReplayEnvelope preserves all metadata", () => {
    const envelope: ReplayEnvelope = {
      sessionID: "sess-abc",
      rootMessageID: "msg-xyz",
      parts: [
        { type: "text", text: "Hello" },
        { type: "tool", name: "bash", input: { command: "ls" } },
      ],
      agent: "agent-v2",
      model: "gpt-4o",
      system: "You are an expert developer",
      format: "json",
      variant: "experimental",
    }

    expect(envelope.sessionID).toBe("sess-abc")
    expect(envelope.rootMessageID).toBe("msg-xyz")
    expect(envelope.agent).toBe("agent-v2")
    expect(envelope.model).toBe("gpt-4o")
    expect(envelope.system).toBe("You are an expert developer")
    expect(envelope.format).toBe("json")
    expect(envelope.variant).toBe("experimental")
    expect(envelope.parts).toHaveLength(2)
  })

  test("ClassifierPayload includes bounded context", () => {
    const payload: ClassifierPayload = {
      rootPrompt: ["user input"],
      lastAssistantText: "Here is my response...",
      finishReason: "length",
      recentToolOutcomes: [
        { toolName: "bash", success: true },
        { toolName: "write", success: false, errorMessage: "Permission denied" },
      ],
      retryCount: 1,
    }

    expect(payload.lastAssistantText).toBe("Here is my response...")
    expect(payload.finishReason).toBe("length")
    expect(payload.recentToolOutcomes).toHaveLength(2)
    expect(payload.recentToolOutcomes[1].toolName).toBe("write")
    expect(payload.recentToolOutcomes[1].success).toBe(false)
    expect(payload.retryCount).toBe(1)
  })

  test("ClassifierPayload can have optional error field", () => {
    const payload: ClassifierPayload = {
      rootPrompt: ["query"],
      lastAssistantText: "Incomplete response",
      finishError: "Model context length exceeded",
      recentToolOutcomes: [],
      retryCount: 0,
    }

    expect(payload.finishError).toBe("Model context length exceeded")
    expect(payload.finishReason).toBeUndefined()
  })

  test("PluginConfig represents enabled and disabled states", () => {
    const disabled: PluginConfig = {
      enabled: false,
      classifierTimeoutMs: 5000,
      maxRetries: 2,
    }

    const enabled: PluginConfig = {
      enabled: true,
      classifierEndpoint: "https://api.openai.com/v1/chat/completions",
      classifierModel: "gpt-4o-mini",
      classifierApiKey: "sk-test-key",
      classifierTimeoutMs: 3000,
      maxRetries: 2,
    }

    expect(disabled.enabled).toBe(false)
    expect(disabled.classifierEndpoint).toBeUndefined()

    expect(enabled.enabled).toBe(true)
    expect(enabled.classifierEndpoint).toBeDefined()
    expect(enabled.classifierModel).toBe("gpt-4o-mini")
    expect(enabled.maxRetries).toBe(2)
  })

  test("Session state can track retry progression", () => {
    let state: SessionState = {
      generation: 1,
      rootMessageID: "msg-1",
      retryCount: 0,
      isEscalated: false,
    }

    expect(state.retryCount).toBe(0)

    state.retryCount = 1
    expect(state.retryCount).toBe(1)

    state.retryCount = 2
    expect(state.retryCount).toBe(2)
  })
})
