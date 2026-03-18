import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { loadConfig } from "../src/config.js"

describe("config parsing", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test("default config enables the plugin and requires classifier settings", () => {
    delete process.env.OPENCODE_PLUGIN_RETRY_ENABLED
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

  test("default-enabled plugin without endpoint throws error", () => {
    delete process.env.OPENCODE_PLUGIN_RETRY_ENABLED
    delete process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"

    expect(() => loadConfig()).toThrow("OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT is required")
  })

  test("default-enabled plugin without model throws error", () => {
    delete process.env.OPENCODE_PLUGIN_RETRY_ENABLED
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    delete process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"

    expect(() => loadConfig()).toThrow("OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL is required")
  })

  test("default-enabled plugin without api key throws error", () => {
    delete process.env.OPENCODE_PLUGIN_RETRY_ENABLED
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    delete process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY

    expect(() => loadConfig()).toThrow("OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY is required")
  })

  test("classifier timeout defaults to 5000ms", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"
    delete process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS

    const config = loadConfig()
    expect(config.classifierTimeoutMs).toBe(5000)
  })

  test("classifier timeout can be overridden", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS = "10000"

    const config = loadConfig()
    expect(config.classifierTimeoutMs).toBe(10000)
  })

  test("classifier timeout must be >= 100ms", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS = "50"

    expect(() => loadConfig()).toThrow("must be >= 100")
  })

  test("classifier timeout rejects non-numeric values", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_TIMEOUT_MS = "not-a-number"

    expect(() => loadConfig()).toThrow("must be >= 100")
  })

  test("max retries defaults to 2", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"
    delete process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES

    const config = loadConfig()
    expect(config.maxRetries).toBe(2)
  })

  test("max retries can be overridden", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"
    process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES = "1"

    const config = loadConfig()
    expect(config.maxRetries).toBe(1)
  })

  test("max retries is clamped to [0, 2]", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"

    process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES = "5"
    expect(loadConfig().maxRetries).toBe(2)

    process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES = "-1"
    expect(loadConfig().maxRetries).toBe(0)
  })

  test("max retries rejects non-numeric values", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_ENDPOINT = "https://api.example.com/chat"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_MODEL = "gpt-4o-mini"
    process.env.OPENCODE_PLUGIN_RETRY_CLASSIFIER_API_KEY = "sk-key"
    process.env.OPENCODE_PLUGIN_RETRY_MAX_RETRIES = "abc"

    expect(() => loadConfig()).toThrow("must be a number")
  })

})
