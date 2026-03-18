import type { ReplayEnvelope, SessionState } from "./types.js"

export interface TrackerSessionSnapshot extends SessionState {
  sessionID: string
  lastAssistantMessageID?: string
}

export interface StartTurnInput {
  sessionID: string
  replayEnvelope: ReplayEnvelope
}

export interface RecordIdleCandidateInput {
  sessionID: string
  generation: number
  lastAssistantMessageID?: string
}

export interface RetryPolicyInput {
  sessionID: string
  maxRetries: number
  generation?: number
}

export interface GenerationScopedInput {
  sessionID: string
  generation?: number
}

export type IdleCandidateFailureReason =
  | "duplicate-idle"
  | "missing-root"
  | "missing-session"
  | "stale-generation"

export interface IdleCandidateResult {
  accepted: boolean
  snapshot?: TrackerSessionSnapshot
  reason?: IdleCandidateFailureReason
}

export type RetryRecordFailureReason =
  | "missing-root"
  | "missing-session"
  | "retry-limit-reached"
  | "stale-generation"

export interface RetryRecordResult {
  recorded: boolean
  snapshot?: TrackerSessionSnapshot
  reason?: RetryRecordFailureReason
}

export type SessionUpdateFailureReason = "missing-session" | "stale-generation"

export interface SessionUpdateResult {
  updated: boolean
  snapshot?: TrackerSessionSnapshot
  reason?: SessionUpdateFailureReason
}

export interface SessionTracker {
  startTurn(input: StartTurnInput): TrackerSessionSnapshot
  getSession(sessionID: string): TrackerSessionSnapshot | undefined
  recordIdleCandidate(input: RecordIdleCandidateInput): IdleCandidateResult
  canRetry(input: RetryPolicyInput): boolean
  recordRetry(input: RetryPolicyInput): RetryRecordResult
  markEscalated(input: GenerationScopedInput): SessionUpdateResult
  cancelGeneration(input: GenerationScopedInput): SessionUpdateResult
  clearPendingIdleForGeneration(input: GenerationScopedInput): SessionUpdateResult
  clearSession(sessionID: string): boolean
}

interface TrackerEntry {
  state: SessionState
  lastAssistantMessageID?: string
  retryCountsByRoot: Map<string, number>
}

function cloneReplayEnvelope(replayEnvelope?: ReplayEnvelope): ReplayEnvelope | undefined {
  if (!replayEnvelope) {
    return undefined
  }

  return {
    ...replayEnvelope,
    parts: [...replayEnvelope.parts],
  }
}

function cloneSnapshot(sessionID: string, entry: TrackerEntry): TrackerSessionSnapshot {
  return {
    ...entry.state,
    replayEnvelope: cloneReplayEnvelope(entry.state.replayEnvelope),
    sessionID,
    lastAssistantMessageID: entry.lastAssistantMessageID,
  }
}

function matchesGeneration(entry: TrackerEntry, generation?: number): boolean {
  return generation === undefined || generation === entry.state.generation
}

function currentRetryCount(entry: TrackerEntry): number {
  const rootMessageID = entry.state.rootMessageID

  if (!rootMessageID) {
    return 0
  }

  return entry.retryCountsByRoot.get(rootMessageID) ?? 0
}

export function createSessionTracker(): SessionTracker {
  const sessions = new Map<string, TrackerEntry>()

  return {
    startTurn({ sessionID, replayEnvelope }) {
      const existing = sessions.get(sessionID)
      const retryCountsByRoot = existing?.retryCountsByRoot ?? new Map<string, number>()
      const generation = (existing?.state.generation ?? 0) + 1
      const retryCount = retryCountsByRoot.get(replayEnvelope.rootMessageID) ?? 0

      const entry: TrackerEntry = {
        state: {
          generation,
          rootMessageID: replayEnvelope.rootMessageID,
          replayEnvelope: cloneReplayEnvelope(replayEnvelope),
          retryCount,
          isEscalated: false,
          pendingIdleGeneration: undefined,
        },
        lastAssistantMessageID: undefined,
        retryCountsByRoot,
      }

      sessions.set(sessionID, entry)

      return cloneSnapshot(sessionID, entry)
    },

    getSession(sessionID) {
      const entry = sessions.get(sessionID)
      return entry ? cloneSnapshot(sessionID, entry) : undefined
    },

    recordIdleCandidate({ sessionID, generation, lastAssistantMessageID }) {
      const entry = sessions.get(sessionID)

      if (!entry) {
        return { accepted: false, reason: "missing-session" }
      }

      if (!entry.state.rootMessageID || !entry.state.replayEnvelope) {
        return { accepted: false, reason: "missing-root" }
      }

      if (generation !== entry.state.generation) {
        return { accepted: false, reason: "stale-generation" }
      }

      if (entry.state.pendingIdleGeneration === generation) {
        return { accepted: false, reason: "duplicate-idle" }
      }

      entry.state.pendingIdleGeneration = generation
      entry.lastAssistantMessageID = lastAssistantMessageID

      return {
        accepted: true,
        snapshot: cloneSnapshot(sessionID, entry),
      }
    },

    canRetry({ sessionID, maxRetries, generation }) {
      const entry = sessions.get(sessionID)

      if (!entry || !matchesGeneration(entry, generation)) {
        return false
      }

      if (entry.state.isEscalated || !entry.state.rootMessageID || !entry.state.replayEnvelope) {
        return false
      }

      return currentRetryCount(entry) < maxRetries
    },

    recordRetry({ sessionID, maxRetries, generation }) {
      const entry = sessions.get(sessionID)

      if (!entry) {
        return { recorded: false, reason: "missing-session" }
      }

      if (!matchesGeneration(entry, generation)) {
        return { recorded: false, reason: "stale-generation" }
      }

      const rootMessageID = entry.state.rootMessageID

      if (!rootMessageID || !entry.state.replayEnvelope) {
        return { recorded: false, reason: "missing-root" }
      }

      const retryCount = currentRetryCount(entry)

      if (retryCount >= maxRetries) {
        return { recorded: false, reason: "retry-limit-reached" }
      }

      const nextRetryCount = retryCount + 1

      entry.retryCountsByRoot.set(rootMessageID, nextRetryCount)
      entry.state.retryCount = nextRetryCount
      entry.state.pendingIdleGeneration = undefined
      entry.state.isEscalated = false

      return {
        recorded: true,
        snapshot: cloneSnapshot(sessionID, entry),
      }
    },

    markEscalated({ sessionID, generation }) {
      const entry = sessions.get(sessionID)

      if (!entry) {
        return { updated: false, reason: "missing-session" }
      }

      if (!matchesGeneration(entry, generation)) {
        return { updated: false, reason: "stale-generation" }
      }

      entry.state.isEscalated = true
      entry.state.pendingIdleGeneration = undefined

      return {
        updated: true,
        snapshot: cloneSnapshot(sessionID, entry),
      }
    },

    cancelGeneration({ sessionID, generation }) {
      const entry = sessions.get(sessionID)

      if (!entry) {
        return { updated: false, reason: "missing-session" }
      }

      if (!matchesGeneration(entry, generation)) {
        return { updated: false, reason: "stale-generation" }
      }

      entry.state.generation += 1
      entry.state.pendingIdleGeneration = undefined
      entry.lastAssistantMessageID = undefined

      return {
        updated: true,
        snapshot: cloneSnapshot(sessionID, entry),
      }
    },

    clearPendingIdleForGeneration({ sessionID, generation }) {
      const entry = sessions.get(sessionID)

      if (!entry) {
        return { updated: false, reason: "missing-session" }
      }

      if (!matchesGeneration(entry, generation)) {
        return { updated: false, reason: "stale-generation" }
      }

      entry.state.pendingIdleGeneration = undefined

      return {
        updated: true,
        snapshot: cloneSnapshot(sessionID, entry),
      }
    },

    clearSession(sessionID) {
      return sessions.delete(sessionID)
    },
  }
}
