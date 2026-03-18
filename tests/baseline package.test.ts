import { describe, test, expect } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import StarterPlugin from "../src/index.js"

describe("baseline package", () => {
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

