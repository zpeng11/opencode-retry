import type { UserMessage } from "@opencode-ai/sdk"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"

import { loadConfig } from "./config.js"
import { MAX_RECENT_TOOL_OUTCOMES, type DetectorToolOutcome } from "./detector.js"
import {
  attemptSafeReplayTransaction,
  listSessionMessages,
  type ReplaySubmissionClientFactory,
  type SessionMessageHistory,
} from "./replay.js"
import { classifyCompletedToolExecution } from "./side-effects.js"
import { createSessionTracker, type TrackerSessionSnapshot } from "./tracker.js"
import type { PluginConfig, ReplayEnvelope } from "./types.js"

type Awaitable<T> = T | Promise<T>

interface RuntimeSessionState {
  recentToolOutcomes: DetectorToolOutcome[]
  hasSuccessfulToolSideEffects: boolean
}

export interface IdleSnapshot {
  sessionID: string
  generation: number
  tracker: TrackerSessionSnapshot
  messages: SessionMessageHistory
  recentToolOutcomes: DetectorToolOutcome[]
  hasSuccessfulToolSideEffects: boolean
}

export interface CreateTruncationRetryHooksOptions {
  config?: PluginConfig
  onIdleSnapshot?: (snapshot: IdleSnapshot) => Awaitable<void>
  replayClientFactory?: ReplaySubmissionClientFactory
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
    hasSuccessfulToolSideEffects: false,
  }
}

function resetRuntimeSessionState(state: RuntimeSessionState): void {
  state.recentToolOutcomes = []
  state.hasSuccessfulToolSideEffects = false
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

  function getOrCreateRuntimeSession(sessionID: string): RuntimeSessionState {
    const existing = sessionState.get(sessionID)
    if (existing) {
      return existing
    }

    const created = createRuntimeSessionState()
    sessionState.set(sessionID, created)
    return created
  }

  async function runIdleSnapshot(snapshot: TrackerSessionSnapshot): Promise<void> {
    const currentBeforeFetch = tracker.getSession(snapshot.sessionID)

    if (!currentBeforeFetch || currentBeforeFetch.generation !== snapshot.generation || currentBeforeFetch.isEscalated) {
      return
    }

    const messages = await listSessionMessages(input.client, snapshot.sessionID)
    const currentAfterFetch = tracker.getSession(snapshot.sessionID)

    if (!currentAfterFetch || currentAfterFetch.generation !== snapshot.generation || currentAfterFetch.isEscalated) {
      return
    }

    const runtime = getOrCreateRuntimeSession(snapshot.sessionID)
    const recentToolOutcomes = cloneValue(runtime.recentToolOutcomes)

    await options.onIdleSnapshot?.({
      sessionID: snapshot.sessionID,
      generation: snapshot.generation,
      tracker: currentAfterFetch,
      messages,
      recentToolOutcomes,
      hasSuccessfulToolSideEffects: runtime.hasSuccessfulToolSideEffects,
    })

    await attemptSafeReplayTransaction({
      client: input.client,
      tracker,
      config,
      sessionID: snapshot.sessionID,
      generation: snapshot.generation,
      recentToolOutcomes,
      directory: input.directory,
      serverUrl: input.serverUrl,
      replayClientFactory: options.replayClientFactory,
    })
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
      })

      if (classifyCompletedToolExecution({ tool: hookInput.tool }).blocksAutoRetry) {
        runtime.hasSuccessfulToolSideEffects = true
      }
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
