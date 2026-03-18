import type { PluginConfig } from "./types.js"
import { ClassifierResult } from "./types.js"

/**
 * Parse and validate plugin configuration from environment variables.
 * Fail loudly if classification is configured but required fields are missing.
 */
export function loadConfig(): PluginConfig {
  const enabled = process.env.OPENCODE_PLUGIN_RETRY_ENABLED !== "false"

  // If disabled, return a minimal config that won't attempt classification
  if (!enabled) {
    return {
      enabled: false,
      classifierTimeoutMs: 5000,
      maxRetries: 2,
    }
  }

  // Classification is enabled; all required fields must be present
  const endpoint = process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT
  const model = process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL
  const apiKey = process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY

  if (!endpoint) {
    throw new Error(
      "OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT is required unless OPENCODE_PLUGIN_RETRY_ENABLED=false"
    )
  }
  if (!model) {
    throw new Error(
      "OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL is required unless OPENCODE_PLUGIN_RETRY_ENABLED=false"
    )
  }
  if (!apiKey) {
    throw new Error(
      "OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY is required unless OPENCODE_PLUGIN_RETRY_ENABLED=false"
    )
  }

  // Parse optional fields with defaults
  let timeoutMs = 5000
  if (process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS) {
    timeoutMs = parseInt(process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS, 10)
    if (isNaN(timeoutMs) || timeoutMs < 100) {
      throw new Error(
        `OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS must be >= 100, got ${process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS}`
      )
    }
  }

  let maxRetries = 2
  if (process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES) {
    maxRetries = parseInt(process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES, 10)
    if (isNaN(maxRetries)) {
      throw new Error(
        `OPENCODE_PLUGIN_RETRY_MAX_RETRIES must be a number, got ${process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES}`
      )
    }
    // Clamp to safe range [0, 2]
    maxRetries = Math.max(0, Math.min(2, maxRetries))
  }

  return {
    enabled: true,
    classifierEndpoint: endpoint,
    classifierModel: model,
    classifierApiKey: apiKey,
    classifierTimeoutMs: timeoutMs,
    maxRetries,
  }
}

export const CLASSIFIER_SYSTEM_PROMPT = `You are a truncation detector. Analyze the provided prompt context and classify whether the assistant was truncated mid-response.

Return ONLY a JSON object with a single "result" field:
- "normal": The response completed naturally (proper sentence ending, no incomplete thought)
- "truncated": The response was clearly cut off (mid-sentence, incomplete code block, unfinished thought)
- "maybe-truncated-needs-judgment": Ambiguous - could be either, requires user judgment

Respond with ONLY the JSON object, no other text.`
