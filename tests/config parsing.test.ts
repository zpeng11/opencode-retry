import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { loadConfig } from "../src/config.js"

describe("config parsing", () => {
  const originalEnv = { ...process.env }

  function setEnabledConfigEnv() {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "true"
  }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test("enabled=false returns minimal config", () => {
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "false"

    const config = loadConfig()

    expect(config).toEqual({
      enabled: false,
      classifierTimeoutMs: 5000,
      maxRetries: 2,
    })
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
