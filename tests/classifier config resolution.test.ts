import { describe, expect, test } from "bun:test"
import type { Config as HostConfig, Provider as HostProvider } from "@opencode-ai/sdk"

import { normalizeClassifierEndpoint, resolveHostClassifierConfig } from "../src/classifier-config.js"

function createProvider(input: {
  id: string
  apiKey?: string
  baseURL?: string
  models: Record<string, { npm: string; url: string }>
}): HostProvider {
  return {
    id: input.id,
    name: input.id,
    source: "config",
    env: [],
    ...(input.apiKey ? { key: input.apiKey } : {}),
    options: input.baseURL ? { baseURL: input.baseURL } : {},
    models: Object.fromEntries(
      Object.entries(input.models).map(([modelID, model]) => [
        modelID,
        {
          id: modelID,
          providerID: input.id,
          name: modelID,
          family: "test",
          api: {
            id: modelID,
            url: model.url,
            npm: model.npm,
          },
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 128_000, output: 8_192 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
        },
      ]),
    ),
  } as HostProvider
}

describe("classifier config resolution", () => {
  test("normalizes base URLs into chat completion endpoints", () => {
    expect(normalizeClassifierEndpoint("https://example.com/v1")).toBe("https://example.com/v1/chat/completions")
    expect(normalizeClassifierEndpoint("https://example.com/v1/")).toBe("https://example.com/v1/chat/completions")
    expect(normalizeClassifierEndpoint("https://example.com/v1/chat/completions")).toBe(
      "https://example.com/v1/chat/completions",
    )
    expect(normalizeClassifierEndpoint("https://example.com/v1?foo=bar")).toBe(
      "https://example.com/v1/chat/completions?foo=bar",
    )
  })

  test("falls back from an unsupported host small_model to the host model", () => {
    const hostConfig: HostConfig = {
      small_model: "anthropic/claude-haiku",
      model: "openai/gpt-4o-mini",
    }
    const providers = [
      createProvider({
        id: "anthropic",
        apiKey: "anthropic-key",
        baseURL: "https://anthropic.example.com",
        models: {
          "claude-haiku": { npm: "@ai-sdk/anthropic", url: "https://anthropic.example.com/v1" },
        },
      }),
      createProvider({
        id: "openai",
        apiKey: "openai-key",
        baseURL: "https://openai.example.com/v1",
        models: {
          "gpt-4o-mini": { npm: "@ai-sdk/openai-compatible", url: "https://openai.example.com/v1" },
        },
      }),
    ]

    const resolved = resolveHostClassifierConfig({
      hostConfig,
      providers,
      classifierTimeoutMs: 500,
    })

    expect(resolved).toEqual({
      classifierEndpoint: "https://openai.example.com/v1/chat/completions",
      classifierModel: "gpt-4o-mini",
      classifierApiKey: "openai-key",
      classifierTimeoutMs: 500,
    })
  })

  test("infers an implicit small model from the configured host model provider", () => {
    const hostConfig: HostConfig = {
      model: "openai/gpt-5",
    }
    const providers = [
      createProvider({
        id: "openai",
        apiKey: "openai-key",
        baseURL: "https://openai.example.com/v1",
        models: {
          "gpt-5": { npm: "@ai-sdk/openai", url: "https://openai.example.com/v1" },
          "gpt-5-nano": { npm: "@ai-sdk/openai", url: "https://openai.example.com/v1" },
        },
      }),
    ]

    const resolved = resolveHostClassifierConfig({
      hostConfig,
      providers,
      classifierTimeoutMs: 500,
    })

    expect(resolved).toEqual({
      classifierEndpoint: "https://openai.example.com/v1/chat/completions",
      classifierModel: "gpt-5-nano",
      classifierApiKey: "openai-key",
      classifierTimeoutMs: 500,
    })
  })

  test("falls back to the current replay model provider when the host model is unset", () => {
    const hostConfig: HostConfig = {}
    const providers = [
      createProvider({
        id: "openai",
        apiKey: "openai-key",
        baseURL: "https://openai.example.com/v1",
        models: {
          "gpt-5": { npm: "@ai-sdk/openai", url: "https://openai.example.com/v1" },
          "gpt-5-nano": { npm: "@ai-sdk/openai", url: "https://openai.example.com/v1" },
        },
      }),
    ]

    const resolved = resolveHostClassifierConfig({
      hostConfig,
      providers,
      classifierTimeoutMs: 500,
      replayModel: { providerID: "openai", modelID: "gpt-5" },
    })

    expect(resolved).toEqual({
      classifierEndpoint: "https://openai.example.com/v1/chat/completions",
      classifierModel: "gpt-5-nano",
      classifierApiKey: "openai-key",
      classifierTimeoutMs: 500,
    })
  })
})
