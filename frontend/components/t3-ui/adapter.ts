// skynet-a adapter (NOT vendored): binds OUR canonical timeline to the vendored T3
// presentation grammar in ./work-entry.ts. Upstream commit 7c1bdd6e1 renders from
// @t3tools/client-runtime WorkLogEntry state; we have no second state model - the
// canonical lane's TimelineNode[] (components/chat/canonical-timeline.ts output) is
// the ONLY source, normalized here through the existing deriveTrace step grammar.
//
// Field mapping (chosen for upstream's icon + preview precedence):
// - `requestKind` (upstream's own field, checked first for icons) carries read/edit/run
//   intent from our trace glyphs; the target rides in `command` so the collapsed
//   preview shows the path/command while the icon stays eye/square-pen/terminal.
// - Uncatalogued/MCP tools ("task" glyph with a real verb) become dynamic_tool_call
//   rows; output rides in `detail` (preview + expanded body), never `command`, so the
//   icon resolves to the hammer, not the terminal.

import { type TimelineNode } from "@/components/chat/timeline";
import { deriveTrace } from "@/components/chat/types";
import { type T3WorkEntry } from "./work-entry";

export type T3RowState = "running" | "done";

/** One canonical timeline node -> one T3 work entry, or null for node kinds this
 *  slice does not render as work rows (text bursts, markers, files, artifacts). */
export function workEntryFromTimelineNode(
  node: TimelineNode,
  state: T3RowState,
): T3WorkEntry | null {
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
  const target = trace.target || undefined;
  const output = trace.detail ?? undefined;
  const entry: T3WorkEntry = {
    id: node.key,
    label: trace.verb,
    tone: trace.isError ? "error" : "tool",
    toolLifecycleStatus: trace.isError
      ? "failed"
      : state === "running"
        ? "inProgress"
        : "completed",
  };

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
): T3WorkEntry[] {
  const entries: T3WorkEntry[] = [];
  for (const [index, node] of nodes.entries()) {
    const state: T3RowState = live && index === nodes.length - 1 ? "running" : "done";
    const entry = workEntryFromTimelineNode(node, state);
    if (entry) entries.push(entry);
  }
  return entries;
}
