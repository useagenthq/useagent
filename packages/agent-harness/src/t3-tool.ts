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
