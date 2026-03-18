import { ClassifierResult } from "./types.js"
import type { ClassifierPayload, ReplayEnvelope } from "./types.js"

export const DEFAULT_RECENT_TOOL_OUTCOME_WINDOW = 5
export const MAX_RECENT_TOOL_OUTCOMES = 5
export const MAX_ROOT_PROMPT_PARTS = 4
export const MAX_ROOT_PROMPT_DEPTH = 4
export const MAX_ROOT_PROMPT_ARRAY_ITEMS = 4
export const MAX_ROOT_PROMPT_OBJECT_KEYS = 8
export const MAX_ROOT_PROMPT_STRING_CHARS = 240
export const MAX_ASSISTANT_TEXT_CHARS = 1600
export const MAX_METADATA_CHARS = 240
export const MAX_TOOL_NAME_CHARS = 80
export const MAX_TOOL_ERROR_CHARS = 160

const SAFE_FINISH_REASONS = new Set([
  "complete",
  "completed",
  "done",
  "endturn",
  "eos",
  "stop",
  "stopsequence",
  "success",
])

const INCOMPLETE_TRAILING_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "via",
  "with",
])

export type DetectorDecision = ClassifierResult.NORMAL | ClassifierResult.TRUNCATED | "needs-classifier"

export interface DetectorToolOutcome {
  toolName: string
  success: boolean
  errorMessage?: string
  toolArgs?: unknown
}

export interface DetectTruncationInput {
  lastAssistantText: string
  finishReason?: string
  finishError?: unknown
}

export interface BuildClassifierPayloadInput extends DetectTruncationInput {
  replayEnvelope: ReplayEnvelope
  recentToolOutcomes?: readonly DetectorToolOutcome[]
  recentToolOutcomeWindow?: number
  retryCount: number
}

export interface DetectorResult {
  decision: DetectorDecision
  finishReason?: string
  finishError?: string
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function normalizeReasonKey(value?: string): string | undefined {
  const normalized = normalizeOptionalString(value)
  return normalized?.toLowerCase().replace(/[\s_-]+/g, "")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function normalizeFinishError(value: unknown): string | undefined {
  const direct = normalizeOptionalString(value)
  if (direct) {
    return direct
  }

  const record = asRecord(value)
  if (!record) {
    return undefined
  }

  const name = normalizeOptionalString(record.name)
  const message = normalizeOptionalString(record.message)
  const data = asRecord(record.data)
  const dataMessage = data ? normalizeOptionalString(data.message) : undefined
  const summary = message ?? dataMessage

  if (name && summary) {
    return name === summary ? name : `${name}: ${summary}`
  }

  return name ?? summary
}

function truncateString(
  value: string | undefined,
  maxChars: number,
  direction: "head" | "tail" = "head"
): string | undefined {
  if (!value) {
    return undefined
  }

  if (value.length <= maxChars) {
    return value
  }

  if (maxChars <= 3) {
    return direction === "tail" ? value.slice(-maxChars) : value.slice(0, maxChars)
  }

  if (direction === "tail") {
    return `...${value.slice(-(maxChars - 3))}`
  }

  return `${value.slice(0, maxChars - 3)}...`
}

function isLengthFinishReason(reason?: string): boolean {
  const key = normalizeReasonKey(reason)
  if (!key) {
    return false
  }

  return (
    key === "length" ||
    key === "maxtokens" ||
    key === "maxoutputtokens" ||
    key === "messageoutputlength" ||
    key.endsWith("outputlength")
  )
}

function isOutputLengthError(error?: string): boolean {
  if (!error) {
    return false
  }

  const normalized = error.toLowerCase()
  const compact = normalized.replace(/[^a-z0-9]+/g, "")

  return (
    compact.includes("messageoutputlengtherror") ||
    /\boutput length\b/.test(normalized) ||
    /\boutput token limit\b/.test(normalized) ||
    /\bmax(?:imum)? output tokens?\b/.test(normalized) ||
    /\boutput too long\b/.test(normalized) ||
    /\bresponse length\b/.test(normalized)
  )
}

function hasUnclosedCodeFence(text: string): boolean {
  const matches = text.match(/```/g)
  return Boolean(matches && matches.length % 2 !== 0)
}

function hasUnbalancedTrailingPairs(text: string): boolean {
  const pairs: Array<[string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]

  return pairs.some(([open, close]) => {
    const openCount = text.split(open).length - 1
    const closeCount = text.split(close).length - 1
    return openCount > closeCount
  })
}

function trailingWord(text: string): string | undefined {
  const pieces = text.split(/\s+/)
  const lastPiece = pieces.at(-1)
  if (!lastPiece) {
    return undefined
  }

  const cleaned = lastPiece.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "")
  return cleaned.length > 0 ? cleaned : undefined
}

function isShortStandaloneReply(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) {
    return false
  }

  const wordCount = compact.split(" ").length
  return wordCount <= 4 && /[a-z0-9]$/i.test(compact)
}

function looksNaturallyFinished(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.endsWith("...")) {
    return false
  }

  if (hasUnclosedCodeFence(trimmed) || hasUnbalancedTrailingPairs(trimmed)) {
    return false
  }

  if (/[,:;\-]$/.test(trimmed)) {
    return false
  }

  const lastWord = trailingWord(trimmed)
  if (lastWord && INCOMPLETE_TRAILING_WORDS.has(lastWord)) {
    return false
  }

  if (trimmed.endsWith("```")) {
    return true
  }

  if (/[.!?"'`)\]}]$/.test(trimmed)) {
    return true
  }

  return isShortStandaloneReply(trimmed)
}

function isSafeFinishReason(reason?: string): boolean {
  const key = normalizeReasonKey(reason)
  return !key || SAFE_FINISH_REASONS.has(key)
}

function clampRecentTurnWindow(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RECENT_TOOL_OUTCOME_WINDOW
  }

  return Math.max(0, Math.min(MAX_RECENT_TOOL_OUTCOMES, Math.trunc(value)))
}

function clampRetryCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.trunc(value))
}

function sanitizeUnknownValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    return truncateString(value, MAX_ROOT_PROMPT_STRING_CHARS) ?? ""
  }

  if (typeof value === "bigint") {
    return value.toString()
  }

  if (typeof value === "undefined") {
    return null
  }

  if (depth >= MAX_ROOT_PROMPT_DEPTH) {
    return "[truncated]"
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ROOT_PROMPT_ARRAY_ITEMS)
      .map((item) => sanitizeUnknownValue(item, depth + 1))
  }

  const record = asRecord(value)
  if (!record) {
    return String(value)
  }

  const entries = Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_ROOT_PROMPT_OBJECT_KEYS)

  const sanitized: Record<string, unknown> = {}

  for (const [key, item] of entries) {
    sanitized[key] = sanitizeUnknownValue(item, depth + 1)
  }

  return sanitized
}

function buildBoundedRootPrompt(replayEnvelope: ReplayEnvelope): ClassifierPayload["rootPrompt"] {
  return replayEnvelope.parts
    .slice(0, MAX_ROOT_PROMPT_PARTS)
    .map((part) => sanitizeUnknownValue(part))
}

export function detectTruncation(input: DetectTruncationInput): DetectorResult {
  const finishReason = normalizeOptionalString(input.finishReason)
  const finishError = normalizeFinishError(input.finishError)

  if (isLengthFinishReason(finishReason) || isOutputLengthError(finishError)) {
    return {
      decision: ClassifierResult.TRUNCATED,
      finishReason,
      finishError,
    }
  }

  if (!finishError && isSafeFinishReason(finishReason) && looksNaturallyFinished(input.lastAssistantText)) {
    return {
      decision: ClassifierResult.NORMAL,
      finishReason,
      finishError,
    }
  }

  return {
    decision: "needs-classifier",
    finishReason,
    finishError,
  }
}

export function buildClassifierPayload(input: BuildClassifierPayloadInput): ClassifierPayload {
  const finishReason = normalizeOptionalString(input.finishReason)
  const finishError = truncateString(normalizeFinishError(input.finishError), MAX_METADATA_CHARS)
  const recentToolOutcomeWindow = clampRecentTurnWindow(input.recentToolOutcomeWindow)
  const recentToolOutcomes = (input.recentToolOutcomes ?? [])
    .slice(-recentToolOutcomeWindow)
    .map((outcome) => ({
      toolName: truncateString(normalizeOptionalString(outcome.toolName) ?? "unknown", MAX_TOOL_NAME_CHARS) ?? "unknown",
      success: outcome.success,
      errorMessage: outcome.success
        ? undefined
        : truncateString(normalizeOptionalString(outcome.errorMessage), MAX_TOOL_ERROR_CHARS),
      toolArgs: outcome.toolArgs === undefined ? undefined : sanitizeUnknownValue(outcome.toolArgs),
    }))

  return {
    rootPrompt: buildBoundedRootPrompt(input.replayEnvelope),
    lastAssistantText:
      truncateString(normalizeOptionalString(input.lastAssistantText) ?? "", MAX_ASSISTANT_TEXT_CHARS, "tail") ?? "",
    finishReason,
    finishError,
    recentToolOutcomes,
    retryCount: clampRetryCount(input.retryCount),
  }
}
