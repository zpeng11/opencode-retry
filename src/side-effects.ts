export const READ_ONLY_TOOL_NAMES = new Set([
  "codesearch",
  "glob",
  "grep",
  "list",
  "lsp",
  "read",
  "todoread",
  "webfetch",
  "websearch",
])

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
  | "read-only-bash-command"
  | "structured-output-tool"
  | "tool-error"
  | "unknown-tool"
  | "unsafe-bash-command"
  | "write-like-or-execute-like-tool"

export interface CompletedToolExecutionLike {
  tool?: string | null
  args?: unknown
}

export interface ToolStateLike {
  status?: string | null
  error?: string | null
  input?: unknown
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

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function isStructuredOutputToolName(tool?: string | null): boolean {
  return Boolean(tool && normalizeToolName(tool) === "structuredoutput")
}

const READ_ONLY_BASH_COMMANDS = new Set(["cat", "grep", "head", "ls", "pwd", "rg", "tail"])
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["branch", "diff", "log", "ls-files", "rev-parse", "show", "status"])

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

function extractBashCommand(value: unknown): string | undefined {
  return normalizeOptionalString(asRecord(value)?.command)
}

function hasUnsafeShellSyntax(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false
      }
      continue
    }

    if (inDoubleQuote) {
      if (char === "\\") {
        escaped = true
        continue
      }

      if (char === "\"") {
        inDoubleQuote = false
        continue
      }

      if (char === "$" && command[index + 1] === "(") {
        return true
      }

      continue
    }

    if (char === "\\") {
      escaped = true
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === "\"") {
      inDoubleQuote = true
      continue
    }

    if (char === "\n" || char === "\r") {
      return true
    }

    if (char === "$" && command[index + 1] === "(") {
      return true
    }

    if (["&", ";", "|", ">", "<", "`", "(", ")"].includes(char)) {
      return true
    }
  }

  return inSingleQuote || inDoubleQuote || escaped
}

function tokenizeShellWords(command: string): string[] | undefined {
  if (hasUnsafeShellSyntax(command)) {
    return undefined
  }

  const tokens: string[] = []
  let current = ""
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false
      } else {
        current += char
      }
      continue
    }

    if (inDoubleQuote) {
      if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inDoubleQuote = false
      } else {
        current += char
      }
      continue
    }

    if (char === "\\") {
      escaped = true
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === "\"") {
      inDoubleQuote = true
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (escaped || inSingleQuote || inDoubleQuote) {
    return undefined
  }

  if (current.length > 0) {
    tokens.push(current)
  }

  return tokens
}

function isReadOnlySedCommand(tokens: readonly string[]): boolean {
  return tokens.includes("-n") && !tokens.some((token) => token === "-i" || token.startsWith("-i") || token === "--in-place")
}

function isReadOnlyGitCommand(tokens: readonly string[]): boolean {
  return tokens.length >= 2 && READ_ONLY_GIT_SUBCOMMANDS.has(tokens[1])
}

function classifyBashExecution(command: string, details: { tool?: string; partType?: string } = {}): SideEffectAssessment {
  const tokens = tokenizeShellWords(command)
  if (!tokens || tokens.length === 0) {
    return createAssessment("unsafe-unknown", "unsafe-bash-command", details)
  }

  const [executable] = tokens

  if (READ_ONLY_BASH_COMMANDS.has(executable)) {
    return createAssessment("read-only", "read-only-bash-command", details)
  }

  if (executable === "git" && isReadOnlyGitCommand(tokens)) {
    return createAssessment("read-only", "read-only-bash-command", details)
  }

  if (executable === "sed" && isReadOnlySedCommand(tokens)) {
    return createAssessment("read-only", "read-only-bash-command", details)
  }

  return createAssessment("unsafe-unknown", "unsafe-bash-command", details)
}

export function classifyToolName(tool?: string | null): SideEffectAssessment {
  if (!tool?.trim()) {
    return createAssessment("unsafe-unknown", "missing-tool-name")
  }

  if (isStructuredOutputToolName(tool)) {
    return createAssessment("read-only", "structured-output-tool", { tool })
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
  if (normalizeToolName(input.tool ?? "") === "bash") {
    const command = extractBashCommand(input.args)
    if (!command) {
      return createAssessment("unsafe-unknown", "unsafe-bash-command", { tool: input.tool ?? undefined })
    }

    return classifyBashExecution(command, { tool: input.tool ?? undefined })
  }

  return classifyToolName(input.tool)
}

export function classifyToolPartSideEffect(part: ToolPartLike): SideEffectAssessment {
  if (!part.state?.status) {
    return createAssessment("unsafe-unknown", "missing-tool-state", {
      partType: part.type ?? undefined,
      tool: part.tool ?? undefined,
    })
  }

  if (isStructuredOutputToolName(part.tool)) {
    return createAssessment("read-only", "structured-output-tool", {
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
    ...classifyCompletedToolExecution({
      tool: part.tool,
      args: part.state.input,
    }),
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
