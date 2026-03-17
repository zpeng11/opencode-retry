import type { Plugin } from "@opencode-ai/plugin"

export const StarterPlugin: Plugin = async () => {
  return {}
}

export default StarterPlugin

export type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
