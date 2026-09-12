// useAgent adapter (NOT vendored): binds OUR canonical timeline to the vendored T3
// presentation grammar in ./work-entry.ts. Upstream commit 7c1bdd6e1 renders from
// @t3tools/client-runtime WorkLogEntry state; we have no second state model - the
// canonical lane's TimelineNode[] (components/chat/canonical-timeline.ts output) is
// the ONLY source, normalized here through the existing deriveTrace step grammar.
//
// Field mapping (chosen for upstream's icon + preview precedence):
// - The heading (`label`) and the collapsed one-line `preview` come from the tool
//   summarizer (components/chat/tool-summary.ts), so a row title is always a human
//   line and never a raw payload.
// - `requestKind` (upstream's own field, checked first for icons) carries read/edit/run
//   intent from our trace glyphs; the target rides in `command` for the expanded body
//   while the icon stays eye/square-pen/terminal.
// - Uncatalogued/MCP tools ("task" glyph with a real verb) become dynamic_tool_call
//   rows; output rides in `detail` (expanded body), never `command`, so the icon
//   resolves to the generic tool glyph, not the terminal.

import { type ChildUsage } from "@/components/chat/child-usage";
import { type TimelineNode } from "@/components/chat/timeline";
import { summarizeToolStep } from "@/components/chat/tool-summary";
import { deriveTrace, parseFileEntries } from "@/components/chat/types";
import { type ChangedFile } from "./changed-files";
import { type ContextWindowUsage } from "./context-window-meter";
import { type WorkEntry } from "./work-entry";

export type RowState = "running" | "done";

/** One canonical timeline node -> one T3 work entry, or null for node kinds this
 *  slice does not render as work rows (text bursts, markers, files, artifacts).
 *  The heading and the collapsed preview come from the tool summarizer (never a
 *  raw payload); `command`/`detail` keep the full payload for the expanded body. */
export function workEntryFromTimelineNode(
  node: TimelineNode,
  state: RowState,
): WorkEntry | null {
  if (node.kind === "reasoning") {
    return {
      id: node.key,
      label: "Thinking",
      tone: "thinking",
      detail: node.text,
    };
  }
  if (node.kind !== "tool") return null;

  const trace = deriveTrace(node.step);
  const summary = summarizeToolStep(node.step);
  const target = trace.target || undefined;
  const output = trace.detail ?? undefined;
  const entry: WorkEntry = {
    id: node.key,
    label: summary.label,
    preview: summary.detail ?? undefined,
    tone: trace.isError ? "error" : "tool",
    toolLifecycleStatus: trace.isError
      ? "failed"
      : state === "running"
        ? "inProgress"
        : "completed",
  };

  // A shell step is a command row whatever the engine called its tool.
  if (summary.command) {
    return { ...entry, requestKind: "command", command: summary.command, detail: output };
  }

  switch (trace.glyph) {
    case "run":
      return { ...entry, requestKind: "command", command: target, detail: output };
    case "read":
    case "list":
      return { ...entry, requestKind: "file-read", command: target, detail: output };
    case "edit":
    case "write":
      return { ...entry, requestKind: "file-change", command: target, detail: output };
    case "search":
    case "fetch":
      return { ...entry, itemType: "web_search", command: target, detail: output };
    case "subagent":
      return { ...entry, taskId: node.step.id, detail: output ?? target };
    case "boot":
      return { ...entry, tone: trace.isError ? "error" : "info", detail: target };
    case "reasoning":
      return { ...entry, tone: trace.isError ? "error" : "thinking", detail: output ?? target };
    case "task":
      // deriveTrace's fallback verb is "Thinking" (narration); everything else on
      // the task glyph is a real uncatalogued/MCP tool call.
      return trace.verb === "Thinking"
        ? { ...entry, tone: trace.isError ? "error" : "thinking", detail: output ?? target }
        : { ...entry, itemType: "dynamic_tool_call", detail: output ?? target };
  }
}

/** Map a canonical timeline to work entries; the LAST node is "running" while live. */
export function workEntriesFromTimeline(
  nodes: readonly TimelineNode[],
  live: boolean,
): WorkEntry[] {
  const entries: WorkEntry[] = [];
  for (const [index, node] of nodes.entries()) {
    const state: RowState = live && index === nodes.length - 1 ? "running" : "done";
    const entry = workEntryFromTimelineNode(node, state);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ── Changed-files aggregation (ChangedFilesCard binding) ───────────────────
//
// Upstream reads a real git checkpoint diff per turn; our canonical lane carries
// no checkpoint, so the aggregate is derived from what the turn's own steps
// state: file-mutating tool steps (deriveTrace glyph edit/write, full paths from
// their code_json via parseFileEntries) plus durable `file` receipt nodes.
// Line stats come ONLY from deriveTrace's honest diffStat (an Edit's old/new
// strings or an explicit patch, denoised) - never fabricated, so a Write with no
// derivable diff renders without a stat.

interface MutableChangedFile {
  path: string;
  kind: string;
  additions: number | null;
  deletions: number | null;
}

function recordChangedFile(
  byPath: Map<string, MutableChangedFile>,
  path: string,
  kind: string,
  additions: number | null,
  deletions: number | null,
): void {
  const prior = byPath.get(path);
  if (!prior) {
    byPath.set(path, { path, kind, additions, deletions });
    return;
  }
  // A file created earlier in the turn is still an "add" for the turn aggregate;
  // any later delete wins outright.
  prior.kind = kind === "delete" ? "delete" : prior.kind === "add" ? "add" : kind;
  if (additions !== null || deletions !== null) {
    prior.additions = (prior.additions ?? 0) + (additions ?? 0);
    prior.deletions = (prior.deletions ?? 0) + (deletions ?? 0);
  }
}

/** Aggregate ONE turn's canonical timeline into changed-file entries for the
 *  ChangedFilesCard/ChangedFilesTree, in first-touched order. */
export function changedFilesFromTimeline(nodes: readonly TimelineNode[]): ChangedFile[] {
  const byPath = new Map<string, MutableChangedFile>();
  for (const node of nodes) {
    if (node.kind === "file") {
      const kind = node.file.changeType === "create" ? "add" : node.file.changeType;
      recordChangedFile(byPath, node.file.path, kind, null, null);
      continue;
    }
    if (node.kind !== "tool") continue;
    const trace = deriveTrace(node.step);
    if (trace.glyph !== "edit" && trace.glyph !== "write") continue;
    const entries = parseFileEntries(node.step);
    // A multi-file step's diffStat covers the whole input; attribute it only
    // when the step names exactly one file (otherwise stats stay unknown).
    const single = entries.length === 1;
    for (const entry of entries) {
      recordChangedFile(
        byPath,
        entry.path,
        entry.kind,
        single ? trace.adds : null,
        single ? trace.dels : null,
      );
    }
  }
  return Array.from(byPath.values(), ({ path, kind, additions, deletions }) => ({
    path,
    kind,
    ...(additions !== null && deletions !== null
      ? { additions, deletions }
      : {}),
  }));
}

// ── Context-window binding ───────────────────────────────────────────────────

/**
 * Bind provider-cumulative usage (the ONLY token signal the frontend receives
 * today - child-session `typedUsage`, normalized by ./child-usage.ts) to the
 * meter's shape. `totalTokens` is cumulative processed tokens, used here as the
 * context-occupancy proxy; `maxTokens` (the model's window) is not exposed by
 * the backend, so callers pass a known limit or the meter renders limit-less.
 */
export function contextWindowFromChildUsage(
  usage: ChildUsage,
  maxTokens: number | null = null,
): ContextWindowUsage {
  return {
    usedTokens: usage.totalTokens,
    maxTokens,
  };
}
