import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { loadConfig } from "../src/config.js"

describe("config parsing", () => {
  const originalEnv = { ...process.env }

  function setEnabledConfigEnv() {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"
  }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test("default-enabled plugin without endpoint throws error", () => {
    delete process.env.OPENCODE_PLUGIN_RETRY_ENABLED
    delete process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"

    expect(() => loadConfig()).toThrow("OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT is required")
  })

  test("enabled=false returns minimal config even if classifier fields exist", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "false"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.openai.com/v1/chat/completions"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-test"

    const config = loadConfig()

    expect(config.enabled).toBe(false)
    expect(config.classifierEndpoint).toBeUndefined()
  })

  test("default-enabled plugin parses successfully with all required fields", () => {
    delete process.env.OPENCODE_PLUGIN_RETRY_ENABLED
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "claude-3.5-sonnet"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key-12345"

    const config = loadConfig()

    expect(config.enabled).toBe(true)
    expect(config.classifierEndpoint).toBe("https://api.example.com/chat")
    expect(config.classifierModel).toBe("claude-3.5-sonnet")
    expect(config.classifierApiKey).toBe("sk-key-12345")
  })

  test("requires model and api key when enabled", () => {
    setEnabledConfigEnv()
    delete process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL
    expect(() => loadConfig()).toThrow("OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL is required")

    setEnabledConfigEnv()
    delete process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY
    expect(() => loadConfig()).toThrow("OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY is required")
  })

  test("classifier timeout defaults to 5000ms and can be overridden", () => {
    setEnabledConfigEnv()
    delete process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS
    expect(loadConfig().classifierTimeoutMs).toBe(5000)

    setEnabledConfigEnv()
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS = "10000"
    expect(loadConfig().classifierTimeoutMs).toBe(10000)
  })

  test("classifier timeout validation rejects invalid values", () => {
    setEnabledConfigEnv()
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS = "50"
    expect(() => loadConfig()).toThrow("must be >= 100")

    setEnabledConfigEnv()
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS = "not-a-number"
    expect(() => loadConfig()).toThrow("must be >= 100")
  })

  test("max retries defaults, overrides, and clamps to [0, 2]", () => {
    setEnabledConfigEnv()
    delete process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES
    expect(loadConfig().maxRetries).toBe(2)

    setEnabledConfigEnv()
    process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES = "1"
    expect(loadConfig().maxRetries).toBe(1)

    setEnabledConfigEnv()
    process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES = "5"
    expect(loadConfig().maxRetries).toBe(2)

    setEnabledConfigEnv()
    process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES = "-1"
    expect(loadConfig().maxRetries).toBe(0)
  })

  test("max retries rejects non-numeric values", () => {
    setEnabledConfigEnv()
    process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES = "abc"

    expect(() => loadConfig()).toThrow("must be a number")
  })
})
