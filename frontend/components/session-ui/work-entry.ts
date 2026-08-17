// Vendored from T3 Code (https://github.com/t3dotgg - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Sources:
//   apps/web/src/session-logic.ts                       (WorkLogEntry shape + tool status heuristics)
//   apps/web/src/components/chat/MessagesTimeline.tsx   (heading/preview/expanded-body/icon grammar,
//                                                        working-timer formatting)
//   apps/web/src/components/chat/MessagesTimeline.logic.ts (normalizeCompactToolLabel, work-group
//                                                           overflow policy MAX_VISIBLE_WORK_LOG_ENTRIES)
//   apps/web/src/filePathDisplay.ts                     (formatWorkspaceRelativePath, trimmed: no
//                                                        Windows drive/position handling)
//
// Port notes (deliberate trims vs upstream, so diffs against upstream stay reviewable):
// - Dropped fields our canonical lane has no source for yet: turnId, requestId approvals,
//   sourceActivityKind, agentSpawn/agentRole (fleet CTA rows live in our Agents rail, not here).
// - `requestKind` is kept: it is upstream's own icon-precedence field and our adapter uses it
//   to carry read/edit/run intent from deriveTrace glyphs.
// - Pure module: no React, no stores, no router. Components bind our canonical TimelineNode
//   through ./adapter.ts - never a second state model.

export type WorkEntryTone = "thinking" | "tool" | "info" | "error";

export type WorkEntryLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

export type WorkEntryItemType =
  | "command_execution"
  | "file_change"
  | "web_search"
  | "image_view"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call";

export type WorkEntryRequestKind = "command" | "file-read" | "file-change";

/** Upstream `WorkLogEntry`, trimmed to the presentation fields this slice renders. */
export interface WorkEntry {
  id: string;
  label: string;
  tone: WorkEntryTone;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: readonly string[];
  toolTitle?: string;
  toolData?: unknown;
  itemType?: WorkEntryItemType;
  requestKind?: WorkEntryRequestKind;
  toolLifecycleStatus?: WorkEntryLifecycleStatus;
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
}

// ── Tool status heuristics (session-logic.ts) ───────────────────────────────

export function workEntryIsToolLike(entry: WorkEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") {
    return true;
  }
  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }
  if (entry.requestKind !== undefined) {
    return true;
  }
  return entry.itemType !== undefined;
}

/** Heuristic: providers often emit successful lifecycle status while error text lives in `detail` / `command`. */
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("file not found")) return true;
  if (t.includes("no files found")) return true;
  if (
    t.includes("enoent") ||
    t.includes("no such file or directory") ||
    t.includes("no such file")
  ) {
    return true;
  }
  if (t.includes("cannot find path") && t.includes("because it does not exist")) return true;
  if (t.includes("commandnotfoundexception")) return true;
  if (t.includes("is not recognized as the name of a cmdlet")) return true;
  if (t.includes("is not recognized") && t.includes("the term '")) return true;
  if (t.includes("a parameter cannot be found that matches parameter name")) return true;
  if (t.includes("command not found")) return true;
  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text)) return true;
  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text)) return true;
  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)) return true;
  return false;
}

/** True when the row should show a failure affordance (explicit status/tone or error-shaped tool output). */
export function workEntryIndicatesToolFailure(entry: WorkEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return true;
  }
  if (!workEntryIsToolLike(entry)) {
    return false;
  }
  const parts: string[] = [];
  if (entry.detail) parts.push(entry.detail);
  if (entry.command) parts.push(entry.command);
  const blob = parts.join("\n");
  if (blob.length === 0) {
    return false;
  }
  return toolDetailTextLooksLikeFailure(blob);
}

/** Tool/command row completed without failure (check affordance). */
export function workEntryIndicatesToolSuccess(entry: WorkEntry): boolean {
  if (!workEntryIsToolLike(entry)) return false;
  if (workEntryIndicatesToolFailure(entry)) return false;
  if (entry.tone === "thinking") return false;
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") return false;
  if (ls === "inProgress") return false;
  if (ls === "stopped") return false;
  return true;
}

/** Tool-like row with neither clear success nor failure (empty, incomplete, in progress, etc.). */
export function workEntryIndicatesToolNeutralStatus(entry: WorkEntry): boolean {
  if (!workEntryIsToolLike(entry)) return false;
  if (workEntryIndicatesToolFailure(entry)) return false;
  if (workEntryIndicatesToolSuccess(entry)) return false;
  return true;
}

// ── Heading / preview / expanded-body grammar (MessagesTimeline.tsx) ────────

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/** Port addition (not upstream): structural noun for an entry whose title/label
 *  normalize to nothing, so a work row can never render heading-less. */
function structuralWorkEntryHeading(entry: WorkEntry): string {
  if (entry.requestKind === "command") return "Run";
  if (entry.requestKind === "file-read") return "Read";
  if (entry.requestKind === "file-change") return "Edit";
  switch (entry.itemType) {
    case "command_execution":
      return "Run";
    case "file_change":
      return "Edit";
    case "web_search":
      return "Search";
    case "image_view":
      return "View image";
    case "mcp_tool_call":
      return "MCP tool";
    case "dynamic_tool_call":
      return "Tool call";
    case "collab_agent_tool_call":
      return "Subagent";
  }
  if (entry.taskId) return "Subagent";
  if (entry.tone === "thinking") return "Thinking";
  return "Tool";
}

export function toolWorkEntryHeading(entry: WorkEntry): string {
  // Upstream reads toolTitle ?? label verbatim. Our lanes can surface entries
  // with no friendly label (child-session/task tool receipts), and the compact
  // normalization can strip a label to "" - a heading-less row renders as a bare
  // chevron+status glyph (user-reported). Every heading is therefore total:
  // toolTitle, then label, then the structural fallback.
  for (const source of [entry.toolTitle, entry.label]) {
    if (!source) continue;
    const heading = capitalizePhrase(normalizeCompactToolLabel(source));
    if (heading.trim().length > 0) return heading;
  }
  return structuralWorkEntryHeading(entry);
}

/** filePathDisplay.ts, trimmed: strip a workspace root down to `rootBasename/relative`. */
export function formatWorkspaceRelativePath(
  path: string,
  workspaceRoot: string | undefined,
): string {
  if (!workspaceRoot) return path;
  const root = workspaceRoot.replace(/\/+$/, "");
  const rootLabel = root.slice(root.lastIndexOf("/") + 1);
  if (path === root) return rootLabel;
  if (path.startsWith(`${root}/`)) return `${rootLabel}/${path.slice(root.length + 1)}`;
  return path;
}

export function workEntryPreview(
  entry: Pick<WorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
): string | null {
  if (entry.command) return entry.command;
  if (entry.detail) return entry.detail;
  if ((entry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = entry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return entry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${entry.changedFiles!.length - 1} more`;
}

export function workEntryRawCommand(
  entry: Pick<WorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = entry.rawCommand?.trim();
  if (!rawCommand || !entry.command) {
    return null;
  }
  return rawCommand === entry.command.trim() ? null : rawCommand;
}

export function buildToolCallExpandedBody(
  entry: WorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(entry.toolData, null, 2)}`);
  }
  const raw = workEntryRawCommand(entry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (entry.command?.trim()) {
    blocks.push(entry.command.trim());
  }
  if (entry.detail?.trim()) {
    blocks.push(entry.detail.trim());
  }
  const changedFiles = entry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles.map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot)).join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

// ── Icon grammar (MessagesTimeline.tsx) ─────────────────────────────────────

export type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

export function workToneIconName(tone: WorkEntryTone): WorkEntryIconName {
  if (tone === "error") return "circle-alert";
  if (tone === "thinking") return "bot";
  if (tone === "info") return "check";
  return "zap";
}

export function workEntryIconName(entry: WorkEntry): WorkEntryIconName {
  if (entry.requestKind === "command") return "terminal";
  if (entry.requestKind === "file-read") return "eye";
  if (entry.requestKind === "file-change") return "square-pen";

  if (entry.itemType === "command_execution" || entry.command) {
    return "terminal";
  }
  if (entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (entry.itemType === "web_search") return "globe";
  if (entry.itemType === "image_view") return "eye";

  switch (entry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "hammer";
    case "collab_agent_tool_call":
      return "bot";
  }

  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (entry.taskId) {
    return "bot";
  }

  return workToneIconName(entry.tone);
}

// ── Work-group overflow policy (MessagesTimeline.logic.ts) ──────────────────

/** Upstream MAX_VISIBLE_WORK_LOG_ENTRIES: collapsed groups keep the newest N rows. */
export const MAX_VISIBLE_WORK_ENTRIES = 1;

export interface WorkEntryOverflow {
  /** Rows to render, chronological. Collapsed: the newest `maxVisible`; expanded: all. */
  visible: WorkEntry[];
  /** Rows hidden behind the "+N previous tool calls" toggle (0 = no toggle). */
  hiddenCount: number;
  /** All rows are tool-like, so the toggle says "tool calls" not "log entries". */
  onlyToolEntries: boolean;
}

export function groupWorkEntryOverflow(
  entries: readonly WorkEntry[],
  expanded: boolean,
  maxVisible: number = MAX_VISIBLE_WORK_ENTRIES,
): WorkEntryOverflow {
  const renderable = entries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry));
  const onlyToolEntries = renderable.every((entry) => workEntryIsToolLike(entry));
  if (renderable.length <= maxVisible) {
    return { visible: renderable, hiddenCount: 0, onlyToolEntries };
  }
  const hidden = renderable.slice(0, -maxVisible);
  return {
    visible: expanded ? renderable : renderable.slice(-maxVisible),
    hiddenCount: hidden.length,
    onlyToolEntries,
  };
}

// ── Working timer (MessagesTimeline.tsx self-ticking label) ─────────────────

export function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}
