// Pure rendering of a completed run into an email digest. Kept separate from the
// transport (delivery) and renderer (event accumulation) so the payload shape is
// unit-testable without a bus, a DB, or SMTP.

/** One accumulated trace line (a tool call or a thinking beat), in order. */
export interface RenderedLine {
  type: "tool" | "thinking";
  text: string;
  toolKind?: string;
}

export interface RenderEmailInput {
  runId: string;
  prompt: string;
  engine: string;
  status: string; // "completed" | "failed" | ...
  summary: string | null;
  durationMs: number | null;
  lines: RenderedLine[];
  assistantText: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/** Render the summary + steps digest for a completed run. */
export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const statusLabel =
    input.status === "completed"
      ? "completed"
      : input.status === "failed"
        ? "FAILED"
        : input.status;
  const promptLine = input.prompt.replace(/\s+/g, " ").trim();
  const subject = `[skynet] Run ${statusLabel} - ${truncate(promptLine, 60) || input.runId}`;

  const duration =
    input.durationMs != null ? `${(input.durationMs / 1000).toFixed(1)}s` : "unknown";

  const stepLines = input.lines.length
    ? input.lines
        .map((l) =>
          l.type === "thinking"
            ? `  · ${l.text}`
            : `  • ${l.text}${l.toolKind ? ` [${l.toolKind}]` : ""}`,
        )
        .join("\n")
    : "  (no steps recorded)";

  const text = [
    `Run ${input.runId}`,
    `Status:   ${input.status}`,
    `Engine:   ${input.engine}`,
    `Duration: ${duration}`,
    "",
    "Prompt:",
    promptLine || "(empty)",
    "",
    "Summary:",
    input.summary?.trim() || "(none)",
    "",
    `Steps (${input.lines.length}):`,
    stepLines,
    "",
    "Assistant output:",
    input.assistantText.trim() || "(none)",
    "",
    "- skynet connectors/email",
  ].join("\n");

  return { subject, text };
}
