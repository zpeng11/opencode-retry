export const READ_ONLY_TOOL_NAMES = new Set(["glob", "grep", "read"])

export const MUTATING_TOOL_NAMES = new Set(["bash", "edit", "multiedit", "write"])

const UNSAFE_TOOL_HINTS = new Set([
  "apply",
  "bash",
  "build",
  "commit",
  "copy",
  "create",
  "delete",
  "deploy",
  "edit",
  "exec",
  "execute",
  "format",
  "install",
  "lint",
  "make",
  "mkdir",
  "move",
  "mv",
  "patch",
  "publish",
  "push",
  "remove",
  "rename",
  "restart",
  "rm",
  "run",
  "shell",
  "test",
  "touch",
  "uninstall",
  "update",
  "write",
])

export type SideEffectClassification = "read-only" | "mutating" | "unsafe-unknown"

export type SideEffectReason =
  | "known-mutating-tool"
  | "known-read-only-tool"
  | "missing-tool-name"
  | "missing-tool-state"
  | "no-side-effects-detected"
  | "non-completed-tool-state"
  | "patch-part"
  | "tool-error"
  | "unknown-tool"
  | "write-like-or-execute-like-tool"

export interface CompletedToolExecutionLike {
  tool?: string | null
}

export interface ToolStateLike {
  status?: string | null
  error?: string | null
}

export interface ToolPartLike {
  type?: string | null
  tool?: string | null
  state?: ToolStateLike | null
}

export interface PatchPartLike {
  type?: string | null
  files?: readonly string[]
}

export interface MessagePartLike {
  type?: string | null
  tool?: string | null
  state?: ToolStateLike | null
  files?: readonly string[]
}

export interface SideEffectAssessment {
  classification: SideEffectClassification
  blocksAutoRetry: boolean
  reason: SideEffectReason
  tool?: string
  partType?: string
}

export interface SideEffectSummary {
  classification: SideEffectClassification
  blocksAutoRetry: boolean
  reasons: SideEffectReason[]
  assessments: SideEffectAssessment[]
}

function normalizeToolName(tool: string): string {
  return tool.trim().toLowerCase()
}

function tokenizeToolName(tool: string): string[] {
  return tool
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function createAssessment(
  classification: SideEffectClassification,
  reason: SideEffectReason,
  details: { tool?: string; partType?: string } = {},
): SideEffectAssessment {
  return {
    classification,
    blocksAutoRetry: classification !== "read-only",
    reason,
    ...details,
  }
}

function getSummaryClassification(assessments: readonly SideEffectAssessment[]): SideEffectClassification {
  if (assessments.some((assessment) => assessment.classification === "mutating")) {
    return "mutating"
  }

  if (assessments.some((assessment) => assessment.classification === "unsafe-unknown")) {
    return "unsafe-unknown"
  }

  return "read-only"
}

function looksWriteLikeOrExecuteLike(tool: string): boolean {
  return tokenizeToolName(tool).some((token) => UNSAFE_TOOL_HINTS.has(token))
}

export function classifyToolName(tool?: string | null): SideEffectAssessment {
  if (!tool?.trim()) {
    return createAssessment("unsafe-unknown", "missing-tool-name")
  }

  const normalizedTool = normalizeToolName(tool)

  if (READ_ONLY_TOOL_NAMES.has(normalizedTool)) {
    return createAssessment("read-only", "known-read-only-tool", { tool })
  }

  if (MUTATING_TOOL_NAMES.has(normalizedTool)) {
    return createAssessment("mutating", "known-mutating-tool", { tool })
  }

  if (looksWriteLikeOrExecuteLike(tool)) {
    return createAssessment("unsafe-unknown", "write-like-or-execute-like-tool", { tool })
  }

  return createAssessment("unsafe-unknown", "unknown-tool", { tool })
}

export function classifyCompletedToolExecution(input: CompletedToolExecutionLike): SideEffectAssessment {
  return classifyToolName(input.tool)
}

export function classifyToolPartSideEffect(part: ToolPartLike): SideEffectAssessment {
  if (!part.state?.status) {
    return createAssessment("unsafe-unknown", "missing-tool-state", {
      partType: part.type ?? undefined,
      tool: part.tool ?? undefined,
    })
  }

  if (part.state.status === "error") {
    return createAssessment("unsafe-unknown", "tool-error", {
      partType: part.type ?? undefined,
      tool: part.tool ?? undefined,
    })
  }

  if (part.state.status !== "completed") {
    return createAssessment("unsafe-unknown", "non-completed-tool-state", {
      partType: part.type ?? undefined,
      tool: part.tool ?? undefined,
    })
  }

  return {
    ...classifyCompletedToolExecution({ tool: part.tool }),
    partType: part.type ?? undefined,
  }
}

export function classifyMessagePartSideEffect(part: MessagePartLike): SideEffectAssessment | undefined {
  if (part.type === "patch") {
    return createAssessment("mutating", "patch-part", { partType: part.type })
  }

  if (part.type === "tool") {
    return classifyToolPartSideEffect(part)
  }

  return undefined
}

export function assessSideEffects(
  input: {
    completedTools?: readonly CompletedToolExecutionLike[]
    parts?: readonly MessagePartLike[]
  } = {},
): SideEffectSummary {
  const assessments: SideEffectAssessment[] = []

  for (const completedTool of input.completedTools ?? []) {
    assessments.push(classifyCompletedToolExecution(completedTool))
  }

  for (const part of input.parts ?? []) {
    const assessment = classifyMessagePartSideEffect(part)

    if (assessment) {
      assessments.push(assessment)
    }
  }

  if (assessments.length === 0) {
    return {
      classification: "read-only",
      blocksAutoRetry: false,
      reasons: ["no-side-effects-detected"],
      assessments: [],
    }
  }

  return {
    classification: getSummaryClassification(assessments),
    blocksAutoRetry: assessments.some((assessment) => assessment.blocksAutoRetry),
    reasons: assessments.map((assessment) => assessment.reason),
    assessments,
  }
}
