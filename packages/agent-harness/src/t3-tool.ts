/**
 * Provider transport labels that describe an envelope rather than the semantic
 * tool being invoked. Keep this list at the harness boundary so durable and
 * canonical projections cannot disagree about placeholder names.
 */
const T3_TRANSPORT_TOOL_NAMES = new Set([
  "dynamic_tool_call",
  "mcp tool call",
  "mcp_tool_call",
  "task",
  "tool",
  "unknown",
]);

const T3_TRANSPORT_TASK_LABELS = new Set([
  "subagent",
  "subagent started",
  "task",
  "task started",
  "tool",
  "tool started",
]);

export function isT3TransportToolName(value: string): boolean {
  return T3_TRANSPORT_TOOL_NAMES.has(value.trim().toLowerCase());
}

export function firstSemanticT3ToolName(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (name && !isT3TransportToolName(name)) return name;
  }
  return null;
}

function descriptiveT3TaskLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && !T3_TRANSPORT_TASK_LABELS.has(label.toLowerCase()) ? label : null;
}

/** Provider-neutral child-task title. Transport envelope labels are never
 * presented as user-facing identity; stable task ids remain the final factual
 * fallback before the generic task kind. */
export function t3TaskDisplayTitle({
  title,
  role,
  taskId,
  summary,
  agent = true,
}: {
  readonly title?: unknown;
  readonly role?: unknown;
  readonly taskId?: unknown;
  readonly summary?: unknown;
  readonly agent?: boolean;
}): string {
  const stableTaskId = descriptiveT3TaskLabel(taskId)?.replaceAll(/[_-]+/gu, " ");
  return descriptiveT3TaskLabel(title) ??
    descriptiveT3TaskLabel(role) ??
    stableTaskId ??
    descriptiveT3TaskLabel(summary) ??
    (agent ? "Subagent" : "Task");
}

export interface T3SummaryToolIdentity {
  readonly server: string;
  readonly tool: string;
}

const T3_SUMMARY_TOOL_PATTERNS = [
  /^([a-z0-9][a-z0-9-]*)\s*·\s*([a-z][a-z0-9_]*?)(?:\s+(?:started|updated|completed|failed|denied|cancelled))?$/iu,
  /^([a-z0-9][a-z0-9-]*)_([a-z][a-z0-9_]*?)(?:\s+(?:started|updated|completed|failed|denied|cancelled))?$/iu,
] as const;

export function t3SummaryToolIdentity(value: unknown): T3SummaryToolIdentity | null {
  if (typeof value !== "string") return null;
  const summary = value.trim();
  for (const pattern of T3_SUMMARY_TOOL_PATTERNS) {
    const match = pattern.exec(summary);
    const server = match?.[1]?.trim();
    const tool = firstSemanticT3ToolName(match?.[2]);
    if (server && tool) return { server, tool };
  }
  return null;
}
