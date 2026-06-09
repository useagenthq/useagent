const TASK_OUTPUT_CHILD_ID = /<task\s+id="(ses_[^"]+)"/;

/** The REAL child session id a `task` ToolPart names: the pin-era
 * `state.metadata.sessionId`, else the `<task id="ses_…">` marker the task tool
 * writes into its output. A SubtaskPart's `sessionID` is the parent session, so
 * generic part/session identifiers must never be used for this correlation. */
export function taskChildSessionId(state: {
  readonly output?: unknown;
  readonly metadata?: unknown;
}): string | null {
  const metadata =
    state.metadata && typeof state.metadata === "object"
      ? (state.metadata as Record<string, unknown>)
      : null;
  const fromMetadata = metadata?.sessionId ?? metadata?.sessionID;
  if (typeof fromMetadata === "string" && fromMetadata) return fromMetadata;
  const output = typeof state.output === "string" ? state.output : "";
  return TASK_OUTPUT_CHILD_ID.exec(output)?.[1] ?? null;
}
