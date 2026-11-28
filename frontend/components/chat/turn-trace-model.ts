// A turn's work as ONE trace, read like chat: the person's message, the agent's
// reply, and everything in between as one block of short step lines. This is
// the pure model behind that block (./turn-trace): which nodes are the work and
// which burst is the reply, one row per work node (a verb-first label, the
// object in a chip, done / failed / running; a mid-work narration burst as a
// plain prose line), the changed files, and the header's words ("Thinking"
// live, "Worked · ran 2 commands · called 1 tool · 4.3s" settled). Every
// engine's steps land here; a bot's thread only starts folded.

import { workEntryFromTimelineNode } from "@/components/session-ui/adapter";
import {
  type WorkEntry,
  workEntryHasExpandedBody,
  workEntryIndicatesToolFailure,
} from "@/components/session-ui/work-entry";
import { workedForMs } from "@/components/session-ui/worked-for-fold";
import { formatElapsed } from "@/utils/format";
import { commandFailedWithRun } from "./command-failed-with-run";
import { familyForGlyph, familyForToolName, type StepFamily } from "./step-icons";
import type { TimelineMarker, TimelineNode, TimelinePlanEntry } from "./timeline";
import { clip, listingEntryCount, summarizeToolStep, toolStepNames } from "./tool-summary";
import {
  type ApiStep,
  deriveTrace,
  firstLine,
  isRenderableTimelineStep,
  parseCommandStep,
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
export function splitTurn(nodes: readonly TimelineNode[], live: boolean): TurnSplit {
  const flow = nodes.filter((node) => !TAIL_KINDS.has(node.kind));
  const tail = nodes.filter((node) => TAIL_KINDS.has(node.kind));
  // A reply is terminal by definition. Text followed by another tool/reasoning
  // node is progress narration and belongs inside the trace; settled history
  // uses the run's durable summary as the answer for that shape.
  const last = flow.at(-1);
  const finalMessageId = last?.kind === "text" ? last.messageId : undefined;
  const replyIndex = last?.kind === "text" && (live || last.final !== false) ? flow.length - 1 : -1;
  let replyStart = replyIndex;
  while (replyStart > 0) {
    const previous = flow[replyStart - 1];
    if (previous?.kind !== "text" || (finalMessageId && previous.messageId !== finalMessageId))
      break;
    replyStart -= 1;
  }
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
  /** How long the step took, when the engine reported it. */
  readonly durationMs: number | null;
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
    durationMs: null,
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
  // A listing's detail is how many entries came back ("3 entries").
  const listing =
    summary.verb === "List" || summary.verb === "Listed" ? listingEntryCount(node.step) : null;
  const detail =
    trace.adds !== null && trace.dels !== null
      ? `+${trace.adds} -${trace.dels}`
      : failed && trace.exitCode !== null && trace.exitCode !== 0
        ? `exit ${trace.exitCode}`
        : listing !== null
          ? `${listing} ${listing === 1 ? "entry" : "entries"}`
          : null;
  const label = family === "reasoning" ? (running ? "Thinking" : "Thought") : summary.verb;
  return {
    kind: "step",
    key: node.key,
    family,
    label,
    chip: chip(summary.object, summary.objectMono),
    detail,
    durationMs: parseCommandStep(node.step).durationMs,
    status: failed ? "failed" : running ? "running" : "done",
    body: workEntryHasExpandedBody(entry) ? { kind: "entry", entry } : null,
  };
}

/** The setup stages the server records, in the words a person would use. They are
 *  mapped when shown, so turns recorded earlier read the same way; a stage not
 *  listed here (such as "Running Codex") is shown as the server wrote it. */
const SETUP_STAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Preparing (?:context and runtime|chat context)\b/u, "Getting ready"],
  [/^Provisioning (?:cloud )?sandbox\b/u, "Starting a computer for this task"],
  [/^Resuming thread sandbox\b/u, "Waking up this task's computer"],
  [/^Activating sandbox image\b/u, "Getting the computer ready, this can take a few minutes"],
  [/^Preparing .*\bintegrations\b/u, "Setting up tools"],
];

function plainSetupLabel(label: string): string {
  return SETUP_STAGES.find(([pattern]) => pattern.test(label))?.[1] ?? label;
}

/** Five lifecycle rows ("Preparing context", "Provisioning cloud sandbox",
 *  "Sandbox bx_x ready in 6s (4 CPU / 8 GiB)", ...) fold into ONE line: "Ready
 *  in 6s" once the computer is up, else the latest stage in plain words. */
function bootRow(
  nodes: readonly Extract<TimelineNode, { kind: "tool" }>[],
  running: boolean,
): TraceStepRow {
  const labels = nodes.map((node) => node.step.label.replace(/[.…]+$/u, "").trim());
  const ready = labels
    .map((label) => /^Sandbox\s+\S+\s+ready in (\S+)(?:\s*\((.*)\))?/.exec(label))
    .findLast(Boolean);
  const latest = labels.at(-1);
  return {
    kind: "step",
    key: nodes[0]?.key ?? "boot",
    family: "boot",
    label: ready ? `Ready in ${ready[1]}` : latest ? plainSetupLabel(latest) : "Getting ready",
    chip: null,
    detail: ready?.[2] ?? null,
    durationMs: null,
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
    durationMs: null,
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
      if (marker.degraded) {
        // An outage frame - the store was unreachable, never a 0-hit recall.
        return {
          ...base,
          family: "memory",
          label: "Memory unavailable",
          chip: chip(marker.query, false),
          detail: "service unavailable",
          status: "failed",
        };
      }
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
        label: "Picking this task back up after a server restart",
        detail: "it may still be finishing",
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
 *  one. Consecutive sandbox lifecycle steps fold into one boot row. Steps a
 *  subagent ran (`childSteps`, the fold's own attribution) render under that
 *  child's row, never here as the parent's work. */
export function traceRowsFromWork(
  work: readonly TimelineNode[],
  live: boolean,
  childSteps?: ReadonlySet<string>,
): TraceRow[] {
  const rows: TraceRow[] = [];
  let boot: Extract<TimelineNode, { kind: "tool" }>[] = [];
  const flushBoot = (running: boolean) => {
    if (boot.length > 0) rows.push(bootRow(boot, running));
    boot = [];
  };
  const own = childSteps
    ? work.filter((node) => !(node.kind === "tool" && childSteps.has(node.step.id)))
    : work;
  for (const [index, node] of own.entries()) {
    const last = index === own.length - 1;
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
  /** Muted text after the label: the running step while live; settled, what
   *  the turn did as counts ("ran 2 commands · called 1 tool · 4.3s"). */
  readonly detail: string | null;
  readonly failed: boolean;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What a settled row counts as in the pill. Reasoning, boot and context
 *  receipts count as nothing; a directory listing is a tool call, not a search,
 *  whatever glyph it draws. */
type CountKind = "command" | "read" | "edit" | "search" | "fetch" | "call";

const COUNT_ORDER: readonly CountKind[] = ["command", "read", "edit", "search", "fetch", "call"];

function countKind(row: TraceStepRow): CountKind | null {
  if (row.family === "reasoning" || row.family === "boot") return null;
  // A listing is a tool call whatever family its glyph drew from: the search
  // family for a list tool, the file-read family for a Codex "List files" read.
  if (/^List(?:ed)?\b/.test(row.label)) return "call";
  switch (row.family) {
    case "shell":
      return "command";
    case "file-read":
      return "read";
    case "file-edit":
    case "file-write":
      return "edit";
    case "web-fetch":
      return "fetch";
    case "search":
      return "search";
    default:
      return "call";
  }
}

function countSegment(kind: CountKind, n: number): string {
  switch (kind) {
    case "command":
      return `ran ${plural(n, "command")}`;
    case "read":
      return `read ${plural(n, "file")}`;
    case "edit":
      return `edited ${plural(n, "file")}`;
    case "search":
      return n === 1 ? "searched once" : `searched ${n} times`;
    case "fetch":
      return `fetched ${plural(n, "page")}`;
    case "call":
      return `called ${plural(n, "tool")}`;
  }
}

/** The header line. Live: "Thinking" plus the running step. A failed run: its
 *  category ("Engine error") with the reason as the detail. Settled: "Worked"
 *  with what it did as the detail ("ran 2 commands · read 1 file · called 1
 *  tool · 4.3s"): one segment per kind of work, "N failed" for the steps that
 *  failed along the way, then the duration (the run's own, else the steps'
 *  timestamps). A turn that only thought reads "Thought". Only a turn the run
 *  itself lost is tinted as a failure, since a step the agent recovered from is
 *  ordinary work. */
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
  const markerKeys = new Set(work.filter((node) => node.kind === "marker").map((node) => node.key));
  const counts = new Map<CountKind, number>();
  for (const row of steps) {
    if (markerKeys.has(row.key)) continue;
    const kind = countKind(row);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  // Distinct files (edit calls plus durable receipts) are the honest edit count.
  if (changedFileCount > 0) counts.set("edit", changedFileCount);
  const segments = COUNT_ORDER.flatMap((kind) => {
    const n = counts.get(kind) ?? 0;
    return n > 0 ? [countSegment(kind, n)] : [];
  });
  const worked = segments.length > 0;
  const failures = traceFailureCount(rows);
  if (failures > 0) segments.push(`${failures} failed`);
  const duration = formatElapsed(durationMs) ?? formatElapsed(workedForMs(work));
  if (duration) segments.push(duration);
  const thought = steps.some((row) => row.family === "reasoning" && row.label === "Thought");
  return {
    label: thought && !worked ? "Thought" : "Worked",
    detail: segments.length > 0 ? segments.join(" · ") : null,
    failed: false,
  };
}
