// One icon language for every step a turn renders. The trace block rows
// (./turn-trace), the vendored work rows (session-ui/work-entry-row) and the
// nested subagent rows (./tool-step-row) all resolve their glyph here, keyed by
// what the step DID (its family), never by which engine or tool name did it.

import {
  type RemixiconComponentType,
  RiBookMarkedLine,
  RiBrainLine,
  RiErrorWarningLine,
  RiFileAddLine,
  RiFileTextLine,
  RiGlobalLine,
  RiPencilLine,
  RiPlugLine,
  RiRobot2Line,
  RiSearchLine,
  RiServerLine,
  RiSparkling2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type { TraceGlyph } from "@/components/chat/types";
import {
  type WorkEntry,
  type WorkEntryIconName,
  workEntryIconName,
} from "@/components/session-ui/work-entry";

/** What a step did, at the resolution a glyph can carry. */
export type StepFamily =
  | "shell"
  | "file-read"
  | "file-edit"
  | "file-write"
  | "search"
  | "web-fetch"
  | "subagent"
  | "memory"
  | "playbook"
  | "tool"
  | "reasoning"
  | "boot";

export const STEP_FAMILIES: readonly StepFamily[] = [
  "shell",
  "file-read",
  "file-edit",
  "file-write",
  "search",
  "web-fetch",
  "subagent",
  "memory",
  "playbook",
  "tool",
  "reasoning",
  "boot",
];

/** The glyph per family (Remix outline set). */
export const STEP_ICON: Readonly<Record<StepFamily, RemixiconComponentType>> = {
  shell: RiTerminalBoxLine,
  "file-read": RiFileTextLine,
  "file-edit": RiPencilLine,
  "file-write": RiFileAddLine,
  search: RiSearchLine,
  "web-fetch": RiGlobalLine,
  subagent: RiRobot2Line,
  memory: RiBrainLine,
  playbook: RiBookMarkedLine,
  tool: RiPlugLine,
  reasoning: RiSparkling2Line,
  boot: RiServerLine,
};

/** A row whose tone is an error, not a family: the one non-family glyph. */
const ERROR_STEP_ICON: RemixiconComponentType = RiErrorWarningLine;

const GLYPH_FAMILY: Readonly<Record<TraceGlyph, StepFamily>> = {
  read: "file-read",
  edit: "file-edit",
  write: "file-write",
  run: "shell",
  search: "search",
  list: "search",
  fetch: "web-fetch",
  subagent: "subagent",
  reasoning: "reasoning",
  task: "tool",
  boot: "boot",
};

/** The family behind a deriveTrace glyph. */
export function familyForGlyph(glyph: TraceGlyph): StepFamily {
  return GLYPH_FAMILY[glyph];
}

/** Families a tool settles by its wire name alone: the gateway's memory and
 *  playbook calls, child sessions, web search and fetch. Null for everything
 *  else, where the trace glyph decides. */
export function familyForToolName(name: string | null | undefined): StepFamily | null {
  if (!name) return null;
  const leaf = name.toLowerCase();
  if (leaf.startsWith("memory_")) return "memory";
  if (leaf.startsWith("skill")) return "playbook";
  if (leaf.startsWith("child_session")) return "subagent";
  if (leaf === "websearch" || leaf === "web_search" || leaf === "gateway_tools_search") {
    return "search";
  }
  if (leaf === "webfetch" || leaf === "web_fetch" || leaf === "fetch") return "web-fetch";
  return null;
}

/** The vendored T3 icon grammar (work-entry.ts workEntryIconName) mapped onto
 *  the families, so the T3 rows draw from the same set as everything else. */
const ENTRY_FAMILY: Readonly<Record<WorkEntryIconName, StepFamily | "error">> = {
  terminal: "shell",
  eye: "file-read",
  "square-pen": "file-edit",
  globe: "web-fetch",
  wrench: "tool",
  hammer: "tool",
  zap: "tool",
  bot: "subagent",
  check: "boot",
  "message-circle": "reasoning",
  "circle-alert": "error",
  x: "error",
};

export function familyForWorkEntry(entry: WorkEntry): StepFamily | "error" {
  // Upstream gives a thinking row the agent glyph; here thought is its own family.
  if (entry.tone === "thinking") return "reasoning";
  return ENTRY_FAMILY[workEntryIconName(entry)];
}

export function iconForWorkEntry(entry: WorkEntry): RemixiconComponentType {
  const family = familyForWorkEntry(entry);
  return family === "error" ? ERROR_STEP_ICON : STEP_ICON[family];
}
