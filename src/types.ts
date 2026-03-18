/**
 * Public types and enums for the truncation retry plugin.
 * Exported from src/index.ts for use by downstream tasks.
 */

/**
 * Classifier result for a turn that may be truncated.
 */
export enum ClassifierResult {
  /** Turn finished normally. No retry needed. */
  NORMAL = "normal",

  /** Turn was truncated. Safe to retry with revert/replay. */
  TRUNCATED = "truncated",

  /** Turn may or may not be truncated. Escalate to user judgment. */
  MAYBE_TRUNCATED_NEEDS_JUDGMENT = "maybe-truncated-needs-judgment",
}

/**
 * Runtime configuration for the plugin, parsed from environment variables.
 * Fail-fast on invalid/incomplete config when classification is enabled.
 */
export interface PluginConfig {
  /** Whether the truncation retry plugin is enabled. Defaults to true unless explicitly set to false. */
  enabled: boolean;

  /** OpenAI-compatible classifier endpoint (e.g., https://api.openai.com/v1/chat/completions). */
  classifierEndpoint?: string;

  /** Classifier model name (e.g., gpt-4o-mini, claude-3.5-sonnet). */
  classifierModel?: string;

  /** API key for the classifier service. */
  classifierApiKey?: string;

  /** Classifier request timeout in milliseconds. Defaults to 5000. */
  classifierTimeoutMs: number;

  /** Maximum automatic retries per root user prompt. Defaults to 2. Clamped to [0, 2]. */
  maxRetries: number;

}

/**
 * Structured classifier payload sent to the small-model endpoint.
 * Bounded to keep request size deterministic and fast.
 */
export interface ClassifierPayload {
  /** Root user prompt envelope: original parts only. */
  rootPrompt: unknown[];

  /** Last assistant text output before the stop. */
  lastAssistantText: string;

  /** Finish reason from the assistant (e.g., "length", "stop_sequence"). */
  finishReason?: string;

  /** Error message if the assistant returned an error. */
  finishError?: string;

  /** Last N tool outcomes (execution and results). */
  recentToolOutcomes: Array<{
    toolName: string;
    success: boolean;
    errorMessage?: string;
    toolArgs?: unknown;
  }>;

  /** Current retry count for this root prompt. */
  retryCount: number;
}

export interface ReplayModel {
  providerID: string;
  modelID: string;
}

export interface ReplayFormat {
  type: string;
  [key: string]: unknown;
}

/**
 * Replay metadata and request envelope for a turn that will be retried.
 * Preserves agent/model/system/format/variant for faithful replay.
 */
export interface ReplayEnvelope {
  /** Session ID for this turn. */
  sessionID: string;

  /** Message ID of the root user prompt. */
  rootMessageID: string;

  /** Original message parts (user input). */
  parts: unknown[];

  /** Agent identifier for replay (e.g., "claude-opus"). */
  agent?: string;

  /** Model to use for replay. */
  model?: string | ReplayModel;

  /** System instructions for replay. */
  system?: string;

  /** Format directive (e.g., "markdown", "json"). */
  format?: string | ReplayFormat;

  /** Variant identifier for replay. */
  variant?: string;
}

/**
 * Per-session state for tracking retries, side effects, and idle work.
 * Mutable session state, keyed by sessionID. Do not store in src/config.ts.
 */
export interface SessionState {
  /** Current generation token for this session. Invalidates stale idle work. */
  generation: number;

  /** Message ID of the root user prompt for the current turn. */
  rootMessageID?: string;

  /** Replay envelope if prompt boundary has been captured. */
  replayEnvelope?: ReplayEnvelope;

  /** Number of automatic retries for the current root prompt. */
  retryCount: number;

  /** Whether this turn has already been escalated. Prevents re-escalation. */
  isEscalated: boolean;

  /** Pending idle job generation. Used for dedupe and stale-work invalidation. */
  pendingIdleGeneration?: number;
}
