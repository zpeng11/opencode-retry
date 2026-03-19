import type { Config as HostConfig, Provider as HostProvider, UserMessage } from "@opencode-ai/sdk"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"

import { resolveHostClassifierConfig } from "./classifier-config.js"
import { loadConfig } from "./config.js"
import { MAX_RECENT_TOOL_OUTCOMES, type DetectorToolOutcome } from "./detector.js"
import {
  stripEscalationWarningFromAssistantText,
  type EscalationWarningClientFactory,
} from "./escalation.js"
import {
  attemptSafeReplayTransaction,
  type ClassifierConfigResolver,
  listSessionMessages,
  type ReplayTransactionResult,
  type ReplaySubmissionClientFactory,
  type SessionMessageHistory,
} from "./replay.js"
import { createSessionTracker, type TrackerSessionSnapshot } from "./tracker.js"
import type { PluginConfig, ReplayEnvelope } from "./types.js"

type Awaitable<T> = T | Promise<T>

interface RuntimeSessionState {
  recentToolOutcomes: DetectorToolOutcome[]
}

export interface IdleSnapshot {
  sessionID: string
  generation: number
  tracker: TrackerSessionSnapshot
  messages: SessionMessageHistory
  recentToolOutcomes: DetectorToolOutcome[]
}

export interface CreateTruncationRetryHooksOptions {
  config?: PluginConfig
  onIdleSnapshot?: (snapshot: IdleSnapshot) => Awaitable<void>
  replayClientFactory?: ReplaySubmissionClientFactory
  escalationWarningClientFactory?: EscalationWarningClientFactory
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function createRuntimeSessionState(): RuntimeSessionState {
  return {
    recentToolOutcomes: [],
  }
}

function toHostProviders(value: unknown): HostProvider[] | undefined {
  const record = asRecord(value)
  if (Array.isArray(record?.providers)) {
    return cloneValue(record.providers as HostProvider[])
  }

  if (Array.isArray(value)) {
    return cloneValue(value as HostProvider[])
  }

  return undefined
}

function resetRuntimeSessionState(state: RuntimeSessionState): void {
  state.recentToolOutcomes = []
}

function appendRecentToolOutcome(state: RuntimeSessionState, outcome: DetectorToolOutcome): void {
  state.recentToolOutcomes = [...state.recentToolOutcomes, outcome].slice(-MAX_RECENT_TOOL_OUTCOMES)
}

function getRootMessageID(input: { messageID?: string }, output: { message: UserMessage }): string | undefined {
  return output.message.id || input.messageID
}

function toReplayEnvelope(
  input: Parameters<NonNullable<Hooks["chat.message"]>>[0],
  output: Parameters<NonNullable<Hooks["chat.message"]>>[1],
): ReplayEnvelope | undefined {
  const rootMessageID = getRootMessageID(input, output)
  const messageRecord = asRecord(output.message)

  if (!rootMessageID) {
    return undefined
  }

  return {
    sessionID: input.sessionID,
    rootMessageID,
    parts: cloneValue(output.parts),
    agent: output.message.agent ?? input.agent,
    model: cloneValue((output.message.model ?? input.model) as unknown) as ReplayEnvelope["model"],
    system: output.message.system,
    format: cloneValue(messageRecord?.format) as ReplayEnvelope["format"],
    variant: typeof messageRecord?.variant === "string" ? messageRecord.variant : input.variant,
  }
}

export function createTruncationRetryHooks(
  input: Pick<PluginInput, "client"> & Partial<Pick<PluginInput, "directory" | "serverUrl">>,
  options: CreateTruncationRetryHooksOptions = {},
): Hooks {
  const config = options.config ?? loadConfig()
  const tracker = createSessionTracker()
  const sessionState = new Map<string, RuntimeSessionState>()
  const idleQueue = new Map<string, Promise<void>>()
  let hostConfigSeed: HostConfig | undefined

  const resolveClassifierConfig: ClassifierConfigResolver = async (classifierInput) => {
    if (!hostConfigSeed) {
      return undefined
    }

    const hostProviders = await input.client.config.providers().then((response) => toHostProviders(response?.data))

    return resolveHostClassifierConfig({
      hostConfig: hostConfigSeed,
      providers: hostProviders,
      classifierTimeoutMs: config.classifierTimeoutMs,
      replayModel: classifierInput.replayModel,
    })
  }

  function getOrCreateRuntimeSession(sessionID: string): RuntimeSessionState {
    const existing = sessionState.get(sessionID)
    if (existing) {
      return existing
    }

    const created = createRuntimeSessionState()
    sessionState.set(sessionID, created)
    return created
  }

  function cleanupSessionTracking(sessionID: string): void {
    sessionState.delete(sessionID)
    tracker.clearSession(sessionID)
    idleQueue.delete(sessionID)
  }

  function shouldCleanupAfterReplayResult(result: ReplayTransactionResult): boolean {
    return (
      result.outcome === "escalated" ||
      (result.outcome === "ignored" &&
        (result.reason === "normal-turn" ||
          result.reason === "assistant-aborted" ||
          result.reason === "assistant-auth-error" ||
          result.reason === "assistant-context-overflow" ||
          result.reason === "assistant-api-error" ||
          result.reason === "assistant-error" ||
          result.reason === "structured-output-complete" ||
          result.reason === "structured-output-error"))
    )
  }

  async function runIdleSnapshot(snapshot: TrackerSessionSnapshot): Promise<void> {
    const currentBeforeFetch = tracker.getSession(snapshot.sessionID)

    if (!currentBeforeFetch || currentBeforeFetch.generation !== snapshot.generation || currentBeforeFetch.isEscalated) {
      return
    }

    const runtime = getOrCreateRuntimeSession(snapshot.sessionID)
    const recentToolOutcomes = cloneValue(runtime.recentToolOutcomes)
    let prefetchedMessages: SessionMessageHistory | undefined

    if (options.onIdleSnapshot) {
      prefetchedMessages = await listSessionMessages(input.client, snapshot.sessionID)
      const currentAfterFetch = tracker.getSession(snapshot.sessionID)

      if (!currentAfterFetch || currentAfterFetch.generation !== snapshot.generation || currentAfterFetch.isEscalated) {
        return
      }

      await options.onIdleSnapshot({
        sessionID: snapshot.sessionID,
        generation: snapshot.generation,
        tracker: currentAfterFetch,
        messages: prefetchedMessages,
        recentToolOutcomes,
      })
    }

    const replayResult = await attemptSafeReplayTransaction({
      client: input.client,
      tracker,
      config,
      resolveClassifierConfig,
      sessionID: snapshot.sessionID,
      generation: snapshot.generation,
      prefetchedMessages,
      recentToolOutcomes,
      directory: input.directory,
      serverUrl: input.serverUrl,
      replayClientFactory: options.replayClientFactory,
      escalationWarningClientFactory: options.escalationWarningClientFactory,
    })

    if (shouldCleanupAfterReplayResult(replayResult)) {
      cleanupSessionTracking(snapshot.sessionID)
    }
  }

  function enqueueIdleSnapshot(snapshot: TrackerSessionSnapshot): void {
    const previous = idleQueue.get(snapshot.sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      await runIdleSnapshot(snapshot)
    })
    const settled = next.catch(() => undefined)

    idleQueue.set(snapshot.sessionID, settled)
    void settled.finally(() => {
      if (idleQueue.get(snapshot.sessionID) === settled) {
        idleQueue.delete(snapshot.sessionID)
      }
    })
  }

  return {
    async config(hostConfig) {
      hostConfigSeed = cloneValue(hostConfig)
    },

    async "experimental.chat.messages.transform"(_hookInput, hookOutput) {
      for (const message of hookOutput.messages) {
        for (const part of message.parts) {
          if (part.type === "text" && message.info.role === "assistant") {
            part.text = stripEscalationWarningFromAssistantText(part.text ?? "", part.metadata)
          }
        }
      }
    },

    async "chat.message"(hookInput, hookOutput) {
      if (!config.enabled) {
        return
      }

      const replayEnvelope = toReplayEnvelope(hookInput, hookOutput)
      if (!replayEnvelope) {
        return
      }

      resetRuntimeSessionState(getOrCreateRuntimeSession(hookInput.sessionID))
      tracker.startTurn({
        sessionID: hookInput.sessionID,
        replayEnvelope,
      })
    },

    async "tool.execute.after"(hookInput) {
      if (!config.enabled) {
        return
      }

      const runtime = getOrCreateRuntimeSession(hookInput.sessionID)

      appendRecentToolOutcome(runtime, {
        toolName: hookInput.tool,
        success: true,
        ...(hookInput.args !== undefined ? { toolArgs: cloneValue(hookInput.args) } : {}),
      })
    },

    async event({ event }) {
      if (!config.enabled || event.type !== "session.status" || event.properties.status.type !== "idle") {
        return
      }

      const current = tracker.getSession(event.properties.sessionID)
      if (!current) {
        return
      }

      const candidate = tracker.recordIdleCandidate({
        sessionID: event.properties.sessionID,
        generation: current.generation,
      })

      if (!candidate.accepted || !candidate.snapshot) {
        return
      }

      enqueueIdleSnapshot(candidate.snapshot)
    },
  }
}

export const TruncationRetryPlugin: Plugin = async (input) => {
  return createTruncationRetryHooks(input)
}

export default TruncationRetryPlugin

export type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
