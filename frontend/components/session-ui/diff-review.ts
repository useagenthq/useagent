"use client";

// Draft review comments on the Diff surface, and the one follow-up message
// they become. The drafts live in a module store keyed by thread, so they
// survive collapsing a file, switching rail tabs and the pane remounting; they
// go away once handed to the reply composer or discarded.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { DiffLine } from "./file-diff-view";

export interface DiffComment {
  readonly id: string;
  readonly path: string;
  /** Which recorded change of the file (index into its hunks). */
  readonly hunk: number;
  /** First and last selected row inside that hunk, inclusive. */
  readonly start: number;
  readonly end: number;
  /** The selected rows as they read when the comment was written. */
  readonly lines: readonly DiffLine[];
  readonly body: string;
}

export type DiffCommentDraft = Omit<DiffComment, "id">;

// ── Message (pure, exported for tests) ──────────────────────────────────────

const span = (numbers: readonly number[]): string => {
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  return first === last ? `line ${first}` : `lines ${first}-${last}`;
};

/** Where the rows sit in the file: new-file lines when any are known, else the
 *  removed lines' old positions, else null (an Edit records no position). */
export function lineRange(lines: readonly DiffLine[]): string | null {
  const after = lines.flatMap((line) => (line.newLine === undefined ? [] : [line.newLine]));
  if (after.length > 0) return span(after);
  const before = lines.flatMap((line) => (line.oldLine === undefined ? [] : [line.oldLine]));
  if (before.length > 0) return `removed ${span(before)}`;
  return null;
}

/** Short label for the UI: the line range, or a row count when unnumbered. */
export function describeLines(lines: readonly DiffLine[]): string {
  return lineRange(lines) ?? (lines.length === 1 ? "1 line" : `${lines.length} lines`);
}

const MARK = { add: "+", del: "-", context: " ", meta: " " } as const;

/** The rows as a ```diff block, with a fence longer than any backtick run in
 *  the code so a quoted fence cannot close it early. */
export function quoteLines(lines: readonly DiffLine[]): string {
  const runs = lines.flatMap((line) => line.text.match(/`+/g) ?? []);
  const longest = Math.max(0, ...runs.map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}diff`, ...lines.map((line) => `${MARK[line.tone]}${line.text}`), fence].join("\n");
}

/** One follow-up message for all drafts: files in the order first commented,
 *  comments top to bottom inside each file, each with its path, line numbers
 *  (when recorded) and the quoted code. */
export function buildReviewMessage(comments: readonly DiffComment[]): string {
  const fileOrder = [...new Set(comments.map((comment) => comment.path))];
  const ordered = [...comments].sort(
    (a, b) =>
      fileOrder.indexOf(a.path) - fileOrder.indexOf(b.path) || a.hunk - b.hunk || a.start - b.start,
  );
  const blocks = ordered.map((comment, index) => {
    const where = lineRange(comment.lines) ?? "line numbers not recorded, see the quoted code";
    return `${index + 1}. ${comment.path}, ${where}\n${quoteLines(comment.lines)}\n${comment.body.trim()}`;
  });
  const intro =
    ordered.length === 1
      ? "I left a comment on your changes. Please address it:"
      : `I left ${ordered.length} comments on your changes. Please address each one:`;
  return [intro, ...blocks].join("\n\n");
}

// ── Draft store ─────────────────────────────────────────────────────────────

const EMPTY: readonly DiffComment[] = [];
const drafts = new Map<string, readonly DiffComment[]>();
const listeners = new Set<() => void>();
let nextId = 0;

function write(key: string, next: readonly DiffComment[]) {
  if (next.length === 0) drafts.delete(key);
  else drafts.set(key, next);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDiffComments(key: string) {
  const comments = useSyncExternalStore(
    subscribe,
    () => drafts.get(key) ?? EMPTY,
    () => EMPTY,
  );
  const add = useCallback((draft: DiffCommentDraft) => {
    nextId += 1;
    write(key, [...(drafts.get(key) ?? EMPTY), { ...draft, id: `diff-comment-${nextId}` }]);
  }, [key]);
  const remove = useCallback((id: string) => {
    write(key, (drafts.get(key) ?? EMPTY).filter((comment) => comment.id !== id));
  }, [key]);
  const clear = useCallback(() => write(key, EMPTY), [key]);
  return useMemo(() => ({ comments, add, remove, clear }), [comments, add, remove, clear]);
}
