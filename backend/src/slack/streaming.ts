/**
 * Slack-native streaming grammar. The chunk shapes here mirror the documented
 * wire contract of chat.startStream / chat.appendStream / chat.stopStream
 * (docs.slack.dev): flat `task_update` objects (`id`/`title`/`status`),
 * `plan_update` with a `title`, `markdown_text` carrying `text`, and a
 * `task_display_mode` of `timeline` or `plan`.
 *
 * Everything in this module is PURE (no I/O) so each shape and translation is
 * unit-testable with fixtures: steps become task updates, plan/todo steps
 * become plan updates, and narration deltas become exact-offset markdown
 * segments. The outbox owns delivery; the watcher and run finalization own
 * sequencing.
 */
import type { CardPhase } from "./card";

export type SlackStreamTaskDisplayMode = "timeline" | "plan";
export type SlackSessionStatus = "processing" | "active";
export type SlackTaskUpdateStatus = "in_progress" | "complete" | "error";

export type SlackMarkdownStreamChunk = {
  readonly type: "markdown_text";
  readonly text: string;
};

export type SlackTaskUpdateStreamChunk = {
  readonly type: "task_update";
  readonly id: string;
  readonly title: string;
  readonly status: SlackTaskUpdateStatus;
  readonly details?: string;
  readonly output?: string;
  readonly sources?: readonly { readonly type: "url"; readonly text: string; readonly url: string }[];
};

export type SlackPlanUpdateStreamChunk = {
  readonly type: "plan_update";
  readonly title: string;
};

export type SlackStreamChunk =
  | SlackMarkdownStreamChunk
  | SlackTaskUpdateStreamChunk
  | SlackPlanUpdateStreamChunk;

/** Task/plan chunk text tops out at 256 chars (Slack docs); stay under it. */
const TASK_TEXT_CAP = 250;
/** One markdown chunk tops out at 12,000 chars (Slack docs); stay under it. */
const MARKDOWN_CHUNK_CAP = 10_000;
/** Total narration streamed into one message body. Past this the watcher stops
 *  appending and the final reply is delivered whole at stopStream instead. */
export const STREAM_NARRATION_CAP = 12_000;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Split free text into markdown chunks WITHOUT altering a single character -
 *  narration offsets count source chars, so truncation here would corrupt the
 *  tail arithmetic at stopStream. Empty text yields no chunks. */
export function markdownChunksFor(text: string): SlackMarkdownStreamChunk[] {
  const chunks: SlackMarkdownStreamChunk[] = [];
  for (let at = 0; at < text.length; at += MARKDOWN_CHUNK_CAP) {
    chunks.push({ type: "markdown_text", text: text.slice(at, at + MARKDOWN_CHUNK_CAP) });
  }
  return chunks;
}

export function taskUpdateChunk(input: {
  readonly id: string;
  readonly title: string;
  readonly status: SlackTaskUpdateStatus;
  readonly output?: string;
}): SlackTaskUpdateStreamChunk {
  return {
    type: "task_update",
    id: truncate(input.id, TASK_TEXT_CAP) || "task",
    title: truncate(input.title, TASK_TEXT_CAP) || "Working",
    status: input.status,
    ...(input.output ? { output: truncate(input.output, TASK_TEXT_CAP) } : {}),
  };
}

export function planUpdateChunk(title: string): SlackPlanUpdateStreamChunk {
  return { type: "plan_update", title: truncate(title, TASK_TEXT_CAP) || "Plan" };
}

/** The stream's opening: one root task card spinning on the run title. No
 *  markdown here - every streamed char stays in the settled message body. */
export function openingStreamChunks(title: string): readonly SlackStreamChunk[] {
  return [taskUpdateChunk({ id: "run", title, status: "in_progress" })];
}

export function runningTaskChunk(step: { readonly id: string; readonly label: string }): SlackTaskUpdateStreamChunk {
  return taskUpdateChunk({ id: taskIdForStep(step.id), title: step.label, status: "in_progress" });
}

function taskIdForStep(stepId: string): string {
  return `step_${stepId}`;
}

/** Progress chunks for a step event: the previously started task flips to
 *  complete (a new tool starting means the last one yielded), the new one
 *  starts. An update to the SAME step (in-place enrichment) never completes
 *  itself. Pure state-in/state-out so the pairing is unit-testable. */
export function stepProgressChunks(
  prev: { readonly id: string; readonly label: string } | null,
  step: { readonly id: string; readonly label: string },
): { chunks: readonly SlackTaskUpdateStreamChunk[]; next: { id: string; label: string } } {
  const next = { id: step.id, label: step.label };
  if (prev && prev.id !== step.id) {
    return {
      chunks: [
        taskUpdateChunk({ id: taskIdForStep(prev.id), title: prev.label, status: "complete" }),
        taskUpdateChunk({ id: taskIdForStep(step.id), title: step.label, status: "in_progress" }),
      ],
      next,
    };
  }
  return {
    chunks: [taskUpdateChunk({ id: taskIdForStep(step.id), title: step.label, status: "in_progress" })],
    next,
  };
}

/** A plan/todos step (todowrite tool or a `plan` chip) becomes ONE plan_update
 *  chunk titling the plan's live progress. Null for a non-plan step. */
export function planUpdateFromStep(step: {
  readonly label: string;
  readonly chip: string | null;
  readonly codeJson: string | null;
}): SlackPlanUpdateStreamChunk | null {
  let parsed: unknown;
  try {
    parsed = step.codeJson ? JSON.parse(step.codeJson) : null;
  } catch {
    parsed = null;
  }
  const code = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const tool = typeof code?.tool === "string" ? code.tool : null;
  if (step.chip !== "plan" && tool !== "todowrite") return null;
  const input = code?.input && typeof code.input === "object" ? (code.input as Record<string, unknown>) : null;
  const todos = Array.isArray(input?.todos)
    ? input.todos.filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
    : [];
  if (todos.length === 0) return planUpdateChunk(step.label);
  const done = todos.filter((t) => {
    const status = typeof t.status === "string" ? t.status : "";
    return status === "completed" || status === "complete" || status === "done";
  }).length;
  const current = todos.find((t) => t.status === "in_progress");
  const currentText = typeof current?.content === "string" ? current.content : null;
  const head = `Plan ${done}/${todos.length}`;
  return planUpdateChunk(currentText ? `${head}: ${currentText}` : head);
}

/** Terminal task closures for stopStream: the last started tool task and the
 *  root run task settle to complete/error. The reply text itself travels
 *  separately (narration tail + closing markdown, sliced at delivery). */
export function terminalTaskChunks(input: {
  readonly phase: CardPhase;
  readonly title: string;
  readonly lastStep?: { readonly id: string; readonly label: string } | null;
}): readonly SlackStreamChunk[] {
  const status: SlackTaskUpdateStatus = input.phase === "failed" ? "error" : "complete";
  return [
    ...(input.lastStep
      ? [taskUpdateChunk({ id: taskIdForStep(input.lastStep.id), title: input.lastStep.label, status })]
      : []),
    taskUpdateChunk({
      id: "run",
      title: input.phase === "failed" ? "Run failed" : input.title,
      status,
    }),
  ];
}

/** The markdown appended AFTER the narration tail at stopStream. Empty when the
 *  streamed narration already CONTAINS the reply (the common live case) -
 *  correctness first: when in doubt the reply is re-stated, never dropped. */
export function composeStreamClosing(input: {
  readonly status: "completed" | "failed";
  readonly summary: string;
  /** The narration the stream body will contain (already capped). */
  readonly narration: string;
}): string {
  const summary = input.summary.trim();
  const summaryCapped = truncate(summary, MARKDOWN_CHUNK_CAP);
  if (input.status === "failed") {
    const prefix = input.narration ? "\n\n" : "";
    return `${prefix}**Run failed**${summaryCapped ? `: ${summaryCapped}` : ""}`;
  }
  if (!input.narration) return summaryCapped || "Done.";
  if (!summary || input.narration.includes(summary)) return "";
  return `\n\n${summaryCapped}`;
}

/** Ordered narration accumulator for the watcher: deltas buffer in, `take()`
 *  drains the next exact-offset segment (capped in TOTAL so a chatty run cannot
 *  flood the thread). Pure + stateful factory, unit-testable without a run. */
export function createNarrationBuffer(cap = STREAM_NARRATION_CAP): {
  push(delta: string): void;
  take(): { text: string; offset: number } | null;
  streamed(): number;
} {
  let pending = "";
  let offset = 0;
  return {
    push(delta) {
      if (offset + pending.length >= cap) return;
      pending += delta;
    },
    take() {
      if (!pending) return null;
      const room = Math.max(0, cap - offset);
      const text = pending.slice(0, room);
      pending = "";
      if (!text) return null;
      const at = offset;
      offset += text.length;
      return { text, offset: at };
    },
    streamed() {
      return offset;
    },
  };
}

/** The live shimmer text for the working step ("<App> is working: <step>"). */
export function statusTextForStep(label: string): string {
  return `is working: ${truncate(label, 120)}`;
}

/** Slack DM channel ids start with "D" - the only surface where the free-text
 *  thread status (assistant.threads.setStatus) is documented to render. */
export function directMessageChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}
