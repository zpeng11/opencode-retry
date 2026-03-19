import { CLASSIFIER_SYSTEM_PROMPT } from "./config.js"
import { ClassifierResult } from "./types.js"
import type { ClassifierPayload, ResolvedClassifierConfig } from "./types.js"

const MAX_FAILURE_CHARS = 240
const VALID_RESULTS = new Set<string>(Object.values(ClassifierResult))

export interface ClassifierCallResult {
  result: ClassifierResult
  failure?: string
}

function abortAfter(ms: number) {
  const controller = new AbortController()
  const id = setTimeout(controller.abort.bind(controller), ms)
  return {
    controller,
    signal: controller.signal,
    clearTimeout: () => globalThis.clearTimeout(id),
  }
}

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

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }

  if (maxChars <= 3) {
    return value.slice(0, maxChars)
  }

  return `${value.slice(0, maxChars - 3)}...`
}

function summarizeUnknown(value: unknown): string | undefined {
  const direct = normalizeOptionalString(value)
  if (direct) {
    return truncateString(direct, MAX_FAILURE_CHARS)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  const record = asRecord(value)
  if (record) {
    const errorRecord = asRecord(record.error)
    const nestedMessage = normalizeOptionalString(errorRecord?.message)
    if (nestedMessage) {
      return truncateString(nestedMessage, MAX_FAILURE_CHARS)
    }

    const name = normalizeOptionalString(record.name)
    const message = normalizeOptionalString(record.message)
    if (name && message) {
      return truncateString(name === message ? name : `${name}: ${message}`, MAX_FAILURE_CHARS)
    }

    if (name) {
      return truncateString(name, MAX_FAILURE_CHARS)
    }

    try {
      return truncateString(JSON.stringify(record), MAX_FAILURE_CHARS)
    } catch {
      return undefined
    }
  }

  return undefined
}

function fallback(failure: string): ClassifierCallResult {
  return {
    result: ClassifierResult.MAYBE_TRUNCATED_NEEDS_JUDGMENT,
    failure: truncateString(failure, MAX_FAILURE_CHARS),
  }
}

function parseJsonText(text: string): unknown {
  return text ? JSON.parse(text) : {}
}

function isAbortError(error: unknown): boolean {
  const record = asRecord(error)
  return normalizeOptionalString(record?.name) === "AbortError"
}

function isClassifierResult(value: unknown): value is ClassifierResult {
  return typeof value === "string" && VALID_RESULTS.has(value)
}

function formatStatus(response: Response): string {
  const statusText = normalizeOptionalString(response.statusText)
  return statusText ? `${response.status} ${statusText}` : String(response.status)
}

function createRequestBody(model: string, payload: ClassifierPayload) {
  return {
    model,
    temperature: 0,
    stream: false,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: CLASSIFIER_SYSTEM_PROMPT },
      { role: "user" as const, content: JSON.stringify(payload) },
    ],
  }
}

export async function classifyWithSmallModel(input: {
  config: ResolvedClassifierConfig
  payload: ClassifierPayload
  fetch?: typeof fetch
  signal?: AbortSignal
}): Promise<ClassifierCallResult> {
  const endpoint = normalizeOptionalString(input.config.classifierEndpoint)
  const model = normalizeOptionalString(input.config.classifierModel)
  const apiKey = normalizeOptionalString(input.config.classifierApiKey)

  if (!endpoint || !model || !apiKey) {
    return fallback("Classifier config is incomplete.")
  }

  const rawTimeoutMs = input.config.classifierTimeoutMs
  if (!Number.isFinite(rawTimeoutMs) || rawTimeoutMs < 100) {
    return fallback("Classifier config timeout is invalid.")
  }

  const timeoutMs = Math.trunc(rawTimeoutMs)
  const timeout = abortAfter(timeoutMs)
  const signal = input.signal ? AbortSignal.any([timeout.signal, input.signal]) : timeout.signal
  const resolvedFetch = input.fetch ?? globalThis.fetch

  if (typeof resolvedFetch !== "function") {
    timeout.clearTimeout()
    return fallback("Classifier fetch implementation is unavailable.")
  }

  const request = new Request(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createRequestBody(model, input.payload)),
    signal,
  })

  try {
    const response = await resolvedFetch(request)

    if (!response.ok) {
      const text = await response.text()
      let parsedError: unknown

      try {
        parsedError = text ? JSON.parse(text) : undefined
      } catch {
        parsedError = text
      }

      const detail = summarizeUnknown(parsedError)
      return fallback(
        detail
          ? `Classifier request failed with ${formatStatus(response)}: ${detail}`
          : `Classifier request failed with ${formatStatus(response)}.`
      )
    }

    const responseText = await response.text()
    let responseBody: unknown

    try {
      responseBody = parseJsonText(responseText)
    } catch {
      return fallback("Classifier response body was not valid JSON.")
    }

    const root = asRecord(responseBody)
    const choices = root?.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      return fallback("Classifier response did not include a chat completion choice.")
    }

    const choice = asRecord(choices[0])
    const message = asRecord(choice?.message)
    if (!message) {
      return fallback("Classifier response did not include a choice message.")
    }

    const content = normalizeOptionalString(message.content)
    if (!content) {
      return fallback("Classifier response did not include a string message content.")
    }

    let classification: unknown
    try {
      classification = JSON.parse(content)
    } catch {
      return fallback("Classifier message content was not valid JSON.")
    }

    const parsedClassification = asRecord(classification)
    if (!parsedClassification) {
      return fallback("Classifier message content was not a JSON object.")
    }

    const result = parsedClassification.result
    if (!isClassifierResult(result)) {
      const invalidResult = summarizeUnknown(result)
      return fallback(
        invalidResult
          ? `Classifier result was invalid: ${invalidResult}.`
          : "Classifier result was invalid: missing result field."
      )
    }

    return { result }
  } catch (error) {
    if (timeout.controller.signal.aborted && !input.signal?.aborted) {
      return fallback(`Classifier request timed out after ${timeoutMs}ms.`)
    }

    if (isAbortError(error)) {
      return fallback("Classifier request was aborted.")
    }

    const detail = summarizeUnknown(error)
    return fallback(detail ? `Classifier request failed: ${detail}` : "Classifier request failed.")
  } finally {
    timeout.clearTimeout()
  }
}
