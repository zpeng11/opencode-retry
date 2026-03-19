import type { Config as HostConfig, Provider as HostProvider } from "@opencode-ai/sdk"

import type { ReplayModel, ResolvedClassifierConfig } from "./types.js"

const OPENAI_COMPATIBLE_PACKAGES = new Set(["@ai-sdk/openai", "@ai-sdk/openai-compatible"])
const DEFAULT_SMALL_MODEL_PRIORITY = [
  "claude-haiku-4-5",
  "claude-haiku-4.5",
  "3-5-haiku",
  "3.5-haiku",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "gpt-5-nano",
]
const BEDROCK_CROSS_REGION_PREFIXES = ["global.", "us.", "eu."]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function parseConfiguredModel(value: string): { providerID: string; modelID: string } | undefined {
  const normalized = normalizeOptionalString(value)
  if (!normalized) {
    return undefined
  }

  const [providerID, ...rest] = normalized.split("/")
  const modelID = rest.join("/")

  if (!providerID || !modelID) {
    return undefined
  }

  return {
    providerID,
    modelID,
  }
}

function normalizeModelReference(input: {
  providerID?: string
  modelID?: string
}): { providerID: string; modelID: string } | undefined {
  const providerID = normalizeOptionalString(input.providerID)
  const modelID = normalizeOptionalString(input.modelID)
  if (!providerID || !modelID) {
    return undefined
  }

  return {
    providerID,
    modelID,
  }
}

function getSmallModelPriority(providerID: string): string[] {
  if (providerID.startsWith("opencode")) {
    return ["gpt-5-nano"]
  }

  if (providerID.startsWith("github-copilot")) {
    return ["gpt-5-mini", "claude-haiku-4.5", ...DEFAULT_SMALL_MODEL_PRIORITY]
  }

  return DEFAULT_SMALL_MODEL_PRIORITY
}

function isOpenAICompatibleModel(model: unknown): boolean {
  const api = asRecord(asRecord(model)?.api)
  const npm = normalizeOptionalString(api?.npm)
  return !!npm && OPENAI_COMPATIBLE_PACKAGES.has(npm)
}

function getProviderApiKey(provider: HostProvider): string | undefined {
  return normalizeOptionalString(provider.key) ?? normalizeOptionalString(asRecord(provider.options)?.apiKey)
}

function getProviderBaseURL(provider: HostProvider, modelID: string): string | undefined {
  const model = provider.models?.[modelID]
  const providerOptions = asRecord(provider.options)
  const modelApi = asRecord(asRecord(model)?.api)

  return (
    normalizeOptionalString(providerOptions?.endpoint) ??
    normalizeOptionalString(providerOptions?.baseURL) ??
    normalizeOptionalString(modelApi?.url)
  )
}

function resolveClassifierConfigForProviderModel(input: {
  provider: HostProvider
  modelID: string
  classifierTimeoutMs: number
}): ResolvedClassifierConfig | undefined {
  const model = input.provider.models?.[input.modelID]
  if (!model || !isOpenAICompatibleModel(model)) {
    return undefined
  }

  const classifierEndpoint = normalizeClassifierEndpoint(getProviderBaseURL(input.provider, input.modelID))
  const classifierApiKey = getProviderApiKey(input.provider)
  if (!classifierEndpoint || !classifierApiKey) {
    return undefined
  }

  return {
    classifierEndpoint,
    classifierModel: input.modelID,
    classifierApiKey,
    classifierTimeoutMs: input.classifierTimeoutMs,
  }
}

function findImplicitSmallModelID(provider: HostProvider): string | undefined {
  const modelIDs = Object.keys(provider.models ?? {})

  for (const item of getSmallModelPriority(provider.id)) {
    if (provider.id === "amazon-bedrock") {
      const candidates = modelIDs.filter((modelID) => modelID.includes(item))
      const globalMatch = candidates.find((modelID) => modelID.startsWith("global."))
      if (globalMatch) {
        return globalMatch
      }

      const region = normalizeOptionalString(asRecord(provider.options)?.region)
      if (region) {
        const regionPrefix = region.split("-")[0]
        if (regionPrefix === "us" || regionPrefix === "eu") {
          const regionalMatch = candidates.find((modelID) => modelID.startsWith(`${regionPrefix}.`))
          if (regionalMatch) {
            return regionalMatch
          }
        }
      }

      const unprefixed = candidates.find(
        (modelID) => !BEDROCK_CROSS_REGION_PREFIXES.some((prefix) => modelID.startsWith(prefix)),
      )
      if (unprefixed) {
        return unprefixed
      }

      continue
    }

    const match = modelIDs.find((modelID) => modelID.includes(item))
    if (match) {
      return match
    }
  }

  return undefined
}

function resolveProviderModelSelection(input: {
  providers: HostProvider[]
  model: { providerID: string; modelID: string }
  classifierTimeoutMs: number
  allowImplicitSmallModel: boolean
}): ResolvedClassifierConfig | undefined {
  const provider = input.providers.find((item) => item.id === input.model.providerID)
  if (!provider) {
    return undefined
  }

  if (input.allowImplicitSmallModel) {
    const implicitSmallModelID = findImplicitSmallModelID(provider)
    if (implicitSmallModelID) {
      const implicitResolved = resolveClassifierConfigForProviderModel({
        provider,
        modelID: implicitSmallModelID,
        classifierTimeoutMs: input.classifierTimeoutMs,
      })
      if (implicitResolved) {
        return implicitResolved
      }
    }
  }

  return resolveClassifierConfigForProviderModel({
    provider,
    modelID: input.model.modelID,
    classifierTimeoutMs: input.classifierTimeoutMs,
  })
}

export function normalizeClassifierEndpoint(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)
  if (!normalized) {
    return undefined
  }

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return undefined
  }

  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
  if (!pathname.endsWith("/chat/completions")) {
    url.pathname = `${pathname}/chat/completions`
  }

  return url.toString()
}

export function resolveHostClassifierConfig(input: {
  hostConfig?: HostConfig
  providers?: HostProvider[]
  classifierTimeoutMs: number
  replayModel?: ReplayModel
}): ResolvedClassifierConfig | undefined {
  if (!input.providers?.length) {
    return undefined
  }

  const explicitHostSmallModel = parseConfiguredModel(input.hostConfig?.small_model ?? "")
  if (explicitHostSmallModel) {
    const resolved = resolveProviderModelSelection({
      providers: input.providers,
      model: explicitHostSmallModel,
      classifierTimeoutMs: input.classifierTimeoutMs,
      allowImplicitSmallModel: false,
    })
    if (resolved) {
      return resolved
    }
  }

  const explicitHostModel = parseConfiguredModel(input.hostConfig?.model ?? "")
  if (explicitHostModel) {
    const resolved = resolveProviderModelSelection({
      providers: input.providers,
      model: explicitHostModel,
      classifierTimeoutMs: input.classifierTimeoutMs,
      allowImplicitSmallModel: true,
    })
    if (resolved) {
      return resolved
    }
  }

  const replayModel = normalizeModelReference(input.replayModel ?? {})
  if (replayModel) {
    return resolveProviderModelSelection({
      providers: input.providers,
      model: replayModel,
      classifierTimeoutMs: input.classifierTimeoutMs,
      allowImplicitSmallModel: true,
    })
  }

  return undefined
}
