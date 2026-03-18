import { afterEach, beforeEach, describe, test, expect } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import StarterPlugin from "../src/index.js"

describe("baseline package", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.OPENCODE_PLUGIN_RETRY_ENABLED = "false"
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test("exports StarterPlugin as default", async () => {
    expect(StarterPlugin).toBeDefined()
    expect(typeof StarterPlugin).toBe("function")
  })

  test("StarterPlugin returns async function", async () => {
    const minimalPluginInput: Partial<PluginInput> = {}
    const result = await StarterPlugin(minimalPluginInput as PluginInput)
    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
  })
})
