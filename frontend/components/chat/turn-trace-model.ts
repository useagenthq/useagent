// A turn's work as ONE trace, read like chat: the person's message, the agent's
// reply, and everything in between as one block of short step lines. This is
// the pure model behind that block (./turn-trace): which nodes are the work and
// which burst is the reply, one row per work node (a verb-first label, the
// object in a chip, done / failed / running; a mid-work narration burst as a
// plain prose line), the changed files, and the header's words ("Thinking"
// live, "Thought for 1m 12s" or "4 tool calls" settled). Every engine's steps
// land here; a bot's thread only starts folded.

import { workEntryFromTimelineNode } from "@/components/session-ui/adapter";
import {
  formatWorkingTimer,
  type WorkEntry,
  workEntryHasExpandedBody,
  workEntryIndicatesToolFailure,
} from "@/components/session-ui/work-entry";
import { workedForDuration } from "@/components/session-ui/worked-for-fold";
import { commandFailedWithRun } from "./command-failed-with-run";
import { familyForGlyph, familyForToolName, type StepFamily } from "./step-icons";
import type { TimelineMarker, TimelineNode, TimelinePlanEntry } from "./timeline";
import { clip, summarizeToolStep, toolStepNames } from "./tool-summary";
import {
  type ApiStep,
  deriveTrace,
  firstLine,
  isRenderableTimelineStep,
  parseTodos,
  type RunStatus,
} from "./types";

// ── Steps -> nodes (the lane without native frames) ──────────────────────────

/**
 * A run's durable steps as timeline nodes, for turns that carry no native
 * frames (settled history, engines without a frame stream). Settled history
 * drops sandbox plumbing (live rendering keeps it: it IS the boot signal). The
 * engine's prose preview of its reply (a `task` step whose label is the first
 * 60 characters of the answer) never renders: the run's summary is the reply.
 * A trailing command the run's failure cut short is marked so it renders as
 * failed, not as the completed step its empty payload would suggest.
 */
export function turnNodesFromSteps(
  steps: readonly ApiStep[],
  live: boolean,
  status: RunStatus,
): TimelineNode[] {
  const failed = commandFailedWithRun(steps, status);
  return steps
    .filter(
      (step) =>
        step.kind !== "done" &&
        isRenderableTimelineStep(step) &&
        !(step.kind === "task" && step.chip === "task") &&
        (live || deriveTrace(step).accent !== "boot"),
    )
    .map((step) =>
      step === failed
        ? { kind: "tool", key: step.id, step, failedWithRun: true }
        : { kind: "tool", key: step.id, step },
    );
}

// ── Split ────────────────────────────────────────────────────────────────────

export interface TurnSplit {
  /** Everything the agent did between the message and its reply, in true order. */
  readonly work: TimelineNode[];
  /** The reply: the last narration burst once settled, or the burst still
   *  streaming at the tail while live. Null until the agent has said something. */
  readonly reply: string | null;
  /** Deliverables (artifacts, file receipts) and follow-up suggestions that close
   *  the turn after the reply. */
  readonly tail: TimelineNode[];
}

/** Keep one trace owner when transient reasoning arrives before its durable
 * native/canonical frame. Once durable reasoning or answer narration exists,
 * the authoritative timeline wins unchanged. */
export function withTransientLiveReasoning(
  timeline: TimelineNode[] | null,
  live: boolean,
  reasoning: string,
): TimelineNode[] | null {
  if (
    timeline === null ||
    !live ||
    !reasoning ||
    timeline.some((node) => node.kind === "text" || node.kind === "reasoning")
  ) {
    return timeline;
  }
  return [...timeline, { kind: "reasoning", key: "transient-live-reasoning", text: reasoning }];
}

const TAIL_KINDS = new Set<TimelineNode["kind"]>(["artifact", "file", "followups"]);

/**
 * Split a turn's timeline into the work, the reply, and the closing tail.
 * While live, only a burst at the very end counts as the reply-in-progress; a
 * burst followed by more work was narration and folds with it.
 */
export function splitTurn(nodes: readonly TimelineNode[], _live: boolean): TurnSplit {
  const flow = nodes.filter((node) => !TAIL_KINDS.has(node.kind));
  const tail = nodes.filter((node) => TAIL_KINDS.has(node.kind));
  // A reply is terminal by definition. Text followed by another tool/reasoning
  // node is progress narration and belongs inside the trace; settled history
  // uses the run's durable summary as the answer for that shape.
  const replyIndex = flow.at(-1)?.kind === "text" ? flow.length - 1 : -1;
  let replyStart = replyIndex;
  while (replyStart > 0 && flow[replyStart - 1]?.kind === "text") replyStart -= 1;
  const replyNodes = replyIndex >= 0 ? flow.slice(replyStart, replyIndex + 1) : [];
  return {
    work: flow.filter((_, index) => index < replyStart || index > replyIndex),
    reply:
      replyNodes.length > 0
        ? replyNodes.map((node) => (node.kind === "text" ? node.text : "")).join("\n\n")
        : null,
    tail,
  };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type TraceRowStatus = "done" | "failed" | "running";

/** What a row shows when opened: reasoning prose, a tool's command + output
 *  (built from the entry only once the row is opened, never up front), or the
 *  failed run's reason, verbatim. */
export type TraceRowBody =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "entry"; readonly entry: WorkEntry }
  | { readonly kind: "failure"; readonly reason: string };

/** The object a step acted on, in a chip after the label: a command, a path
 *  or a slug in mono; a query or a line of prose in text. */
export interface TraceChip {
  readonly text: string;
  readonly mono: boolean;
}

/** One step of the work as a short line. */
export interface TraceStepRow {
  readonly kind: "step";
  readonly key: string;
  readonly family: StepFamily;
  /** The short verb-first line a person reads: "Run", "Read", "Recalled memory". */
  readonly label: string;
  readonly chip: TraceChip | null;
  /** Muted text after the chip: a count, a version, an exit code, a diff stat. */
  readonly detail: string | null;
  readonly status: TraceRowStatus;
  readonly body: TraceRowBody | null;
}

/** What the agent said mid-work (a burst followed by more steps): a muted
 *  prose line inside the trace, with no verb and no chip. */
export interface TraceNarrationRow {
  readonly kind: "narration";
  readonly key: string;
  readonly text: string;
}

export type TraceRow = TraceStepRow | TraceNarrationRow;

const CHIP_MAX = 96;

function chip(text: string | null | undefined, mono: boolean): TraceChip | null {
  const line = text ? clip(firstLine(text) || text, CHIP_MAX) : "";
  return line ? { text: line, mono } : null;
}

function proseRow(key: string, text: string, label: string, running: boolean): TraceStepRow | null {
  const line = chip(text, false);
  if (!line) return null;
  return {
    kind: "step",
    key,
    family: "reasoning",
    label,
    chip: line,
    detail: null,
    status: running ? "running" : "done",
    body: { kind: "prose", text },
  };
}

function narrationRow(key: string, text: string): TraceNarrationRow | null {
  return text.trim() ? { kind: "narration", key, text } : null;
}

function toolRow(
  node: Extract<TimelineNode, { kind: "tool" }>,
  running: boolean,
): TraceStepRow | null {
  // A plan (todowrite) renders as the checklist, never as a step line.
  if (parseTodos(node.step)) return null;
  const entry = workEntryFromTimelineNode(node, running ? "running" : "done");
  if (!entry) return null;
  const trace = deriveTrace(node.step);
  const summary = summarizeToolStep(node.step);
  const failed = workEntryIndicatesToolFailure(entry);
  const family: StepFamily =
    entry.tone === "thinking"
      ? "reasoning"
      : summary.command !== null
        ? "shell"
        : (toolStepNames(node.step)
            .map(familyForToolName)
            .find((candidate) => candidate !== null) ?? familyForGlyph(trace.glyph));
  const detail =
    trace.adds !== null && trace.dels !== null
      ? `+${trace.adds} -${trace.dels}`
      : failed && trace.exitCode !== null && trace.exitCode !== 0
        ? `exit ${trace.exitCode}`
        : null;
  const label = family === "reasoning" ? (running ? "Thinking" : "Thought") : summary.verb;
  return {
    kind: "step",
    key: node.key,
    family,
    label,
    chip: chip(summary.object, summary.objectMono),
    detail,
    status: failed ? "failed" : running ? "running" : "done",
    body: workEntryHasExpandedBody(entry) ? { kind: "entry", entry } : null,
  };
}

/** Five lifecycle rows ("Preparing context", "Provisioning cloud sandbox",
 *  "Sandbox bx_x ready in 6s (4 CPU / 8 GiB)", ...) fold into ONE line: the
 *  ready line once the sandbox is up, else the latest stage while it boots. */
function bootRow(
  nodes: readonly Extract<TimelineNode, { kind: "tool" }>[],
  running: boolean,
): TraceStepRow {
  const labels = nodes.map((node) => node.step.label.replace(/[.…]+$/u, "").trim());
  const ready = labels
    .map((label) => /^Sandbox\s+\S+\s+ready in (\S+)(?:\s*\((.*)\))?/.exec(label))
    .findLast(Boolean);
  return {
    kind: "step",
    key: nodes[0]?.key ?? "boot",
    family: "boot",
    label: ready ? `Sandbox ready in ${ready[1]}` : (labels.at(-1) ?? "Preparing"),
    chip: null,
    detail: ready?.[2] ?? null,
    status: running && !ready ? "running" : "done",
    body: null,
  };
}

function markerRow(key: string, marker: TimelineMarker, running: boolean): TraceStepRow {
  const base = {
    kind: "step" as const,
    key,
    chip: null,
    detail: null,
    status: "done" as TraceRowStatus,
    body: null,
  };
  switch (marker.kind) {
    case "skill":
      return {
        ...base,
        family: "playbook",
        label: marker.playbook ? "Activated playbook" : "Loaded skill",
        chip: chip(marker.name, true),
        detail: `v${marker.version}`,
      };
    case "context": {
      const known = marker.source === "knowledge" || marker.source === "memory";
      const n = marker.itemCount;
      return {
        ...base,
        family: "memory",
        label: `Recalled ${known ? marker.source : "context"}`,
        chip: chip(marker.query, false),
        detail: `${n} ${n === 1 ? "item" : "items"}`,
      };
    }
    case "reconciling":
      return {
        ...base,
        family: "boot",
        label: "Reconciling after a restart",
        detail: "the turn may still be completing",
        status: running ? "running" : "done",
      };
    case "memory": {
      const pool = marker.scope === "personal" ? "personal memory" : "organization memory";
      if (marker.failed) {
        // Honest write failure - distinct from a 0-hit recall, never a fake save.
        const label =
          marker.op === "correct"
            ? "Memory update failed"
            : marker.op === "forget"
              ? "Memory delete failed"
              : marker.op === "search"
                ? "Memory recall unavailable"
                : "Memory not saved";
        return {
          ...base,
          family: "memory",
          label,
          detail: "service unavailable",
          status: "failed",
        };
      }
      if (marker.op === "correct") return { ...base, family: "memory", label: `Updated ${pool}` };
      if (marker.op === "forget")
        return { ...base, family: "memory", label: `Forgot from ${pool}` };
      // remember: L0 write is durable + searchable now; L1 distillation is async
      // and unobserved during the turn, so "indexing" is the terminal detail.
      return {
        ...base,
        family: "memory",
        label: `Remembered in ${pool}`,
        detail: marker.reconciled ? "already saved" : "indexing",
      };
    }
    case "approval": {
      const verb =
        marker.state === "requested"
          ? "Approval requested"
          : marker.status === "approved"
            ? "Approved"
            : marker.status === "denied"
              ? "Denied"
              : "Expired";
      const by = marker.state === "resolved" && marker.resolvedBy ? ` by ${marker.resolvedBy}` : "";
      return {
        ...base,
        family: "tool",
        label: `${verb}${by}`,
        chip: chip(marker.toolName, true),
        status: marker.state === "requested" && running ? "running" : "done",
      };
    }
  }
}

/** One work node -> one trace row; null for nodes that never become a line
 *  (plans render as the checklist, empty bursts render nothing). */
function traceRowFromNode(node: TimelineNode, running: boolean): TraceRow | null {
  switch (node.kind) {
    case "reasoning":
      return proseRow(node.key, node.text, running ? "Thinking" : "Thought", running);
    case "text":
      return narrationRow(node.key, node.text);
    case "marker":
      return markerRow(node.key, node.marker, running);
    case "tool":
      return toolRow(node, running);
    default:
      return null;
  }
}

const isBoot = (node: TimelineNode): node is Extract<TimelineNode, { kind: "tool" }> =>
  node.kind === "tool" && deriveTrace(node.step).accent === "boot";

/** The trace rows of a turn's work; while live the LAST node is the running
 *  one. Consecutive sandbox lifecycle steps fold into one boot row. */
export function traceRowsFromWork(work: readonly TimelineNode[], live: boolean): TraceRow[] {
  const rows: TraceRow[] = [];
  let boot: Extract<TimelineNode, { kind: "tool" }>[] = [];
  const flushBoot = (running: boolean) => {
    if (boot.length > 0) rows.push(bootRow(boot, running));
    boot = [];
  };
  for (const [index, node] of work.entries()) {
    const last = index === work.length - 1;
    if (isBoot(node)) {
      boot.push(node);
      if (last) flushBoot(live);
      continue;
    }
    flushBoot(false);
    const row = traceRowFromNode(node, live && last);
    if (row) rows.push(row);
  }
  return rows;
}

export function traceFailureCount(rows: readonly TraceRow[]): number {
  return rows.filter((row) => row.kind === "step" && row.status === "failed").length;
}

/** The turn's latest plan (a canonical plan node or a todowrite step), rendered
 *  as the checklist beside the trace; null when the turn carried none. */
export function latestPlanEntries(
  work: readonly TimelineNode[],
): readonly TimelinePlanEntry[] | null {
  for (let index = work.length - 1; index >= 0; index -= 1) {
    const node = work[index];
    if (node?.kind === "plan") return node.entries;
    if (node?.kind === "tool") {
      const todos = parseTodos(node.step);
      if (todos) return todos.map(({ id, content, status }) => ({ id, text: content, status }));
    }
  }
  return null;
}

// ── Header ───────────────────────────────────────────────────────────────────

export interface TraceHeader {
  readonly label: string;
  /** Muted text after the label: the running step while live, the counts or
   *  the duration once settled. */
  readonly detail: string | null;
  readonly failed: boolean;
}

function formatDurationMs(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return formatWorkingTimer(new Date(0).toISOString(), new Date(durationMs).toISOString());
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The header line. Live: "Thinking" plus the running step. A failed run: its
 *  category ("Engine error") with the reason as the detail. Settled: "Thought
 *  for 3m 12s" (the run's own duration, else the steps' timestamps) with the
 *  call counts as the detail when the turn reasoned; otherwise the counts
 *  themselves ("4 tool calls, 2 messages") with the duration as the detail.
 *  ", N failed" when steps failed. */
export function traceHeader({
  live,
  rows,
  work,
  durationMs,
  changedFileCount = 0,
  failure = null,
}: {
  live: boolean;
  rows: readonly TraceRow[];
  work: readonly TimelineNode[];
  /** The settled run's own duration; falls back to the work's step timestamps. */
  durationMs: number | null;
  /** Complete-turn file aggregate, including durable file.changed receipts. */
  changedFileCount?: number;
  /** The run's terminal failure (./turn-failure): why it stopped is the line. */
  failure?: { readonly label: string; readonly reason: string } | null;
}): TraceHeader {
  const steps = rows.filter((row) => row.kind === "step");
  if (live) {
    const running = steps.findLast((row) => row.status === "running");
    const detail = running
      ? running.chip
        ? `${running.label} ${running.chip.text}`
        : running.label
      : null;
    return { label: "Thinking", detail, failed: false };
  }
  if (failure) return { label: failure.label, detail: firstLine(failure.reason), failed: true };
  const failures = traceFailureCount(rows);
  const thoughts = steps.filter(
    (row) => row.family === "reasoning" && row.label === "Thought",
  ).length;
  const messages = rows.filter((row) => row.kind === "narration").length;
  const markerKeys = new Set(work.filter((node) => node.kind === "marker").map((node) => node.key));
  const calls = steps.filter(
    (row) => row.family !== "reasoning" && row.family !== "boot" && !markerKeys.has(row.key),
  ).length;
  const counts = [
    calls > 0 ? plural(calls, "tool call") : null,
    messages > 0 ? plural(messages, "message") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const duration = formatDurationMs(durationMs) ?? workedForDuration(work);
  const failedSuffix = failures > 0 ? `, ${failures} failed` : "";
  if (thoughts > 0) {
    const thought = duration ? `Thought for ${duration}` : "Thought";
    return { label: `${thought}${failedSuffix}`, detail: counts || null, failed: failures > 0 };
  }
  return {
    label: `${counts || (changedFileCount > 0 ? `Changed ${plural(changedFileCount, "file")}` : "Context")}${failedSuffix}`,
    detail: duration,
    failed: failures > 0,
  };
}
