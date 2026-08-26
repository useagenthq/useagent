"use client";

// useAgent Diff surface body (NOT vendored; composes the vendored T3 grammar:
// ChangedFilesCard as the file index, DiffStatLabel for honest line stats).
//
// The per-file unified diff is recovered ONLY from what the run's own file/edit
// steps recorded in code_json (an Edit's old/new strings, a MultiEdit's edits,
// an explicit patch/diff body, a Write's full content) - never fabricated. A
// changed file whose step payload carried no patch text renders its change
// receipt + stats with an explicit "patch content not recorded" note.

import { RiArrowRightSLine } from "@remixicon/react";
import { memo, useCallback, useRef, useState } from "react";
import { FileKindBadge } from "@/components/chat/tool-step-row";
import {
  type ApiStep,
  asRecord,
  deriveTrace,
  type FileChangeKind,
  parseFileEntries,
  parseStepCode,
} from "@/components/chat/types";
import { cx as cn } from "@/utils/cx";
import { CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT, type ChangedFile } from "./changed-files";
import { ChangedFilesCard } from "./changed-files-tree";
import { hasNonZeroStat, DiffStatLabel } from "./diff-stat-label";

// ── Patch model (pure, exported for tests) ──────────────────────────────────

export type DiffLineTone = "add" | "del" | "context" | "meta";

export interface DiffLine {
  readonly tone: DiffLineTone;
  readonly text: string;
}

/** One contiguous recorded change (one Edit, one MultiEdit entry, one patch body). */
export type DiffHunk = readonly DiffLine[];

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const toLines = (text: string): string[] => text.replace(/\n$/, "").split("\n");

/** Classify a recorded unified-diff (or codex apply_patch) body into toned lines.
 *  Header/hunk rows (diff/index/---/+++/@@/***) are meta; +/- prefixes are
 *  stripped into the gutter marker the row renders. */
export function parsePatchLines(patch: string): DiffLine[] {
  return toLines(patch).map((line): DiffLine => {
    if (/^(diff |index |--- |\+\+\+ |@@|\*\*\*)/.test(line)) return { tone: "meta", text: line };
    if (line.startsWith("+")) return { tone: "add", text: line.slice(1) };
    if (line.startsWith("-")) return { tone: "del", text: line.slice(1) };
    return { tone: "context", text: line.startsWith(" ") ? line.slice(1) : line };
  });
}

/** An Edit tool's own strings ARE the hunk: the exact replaced fragment as
 *  deletions followed by the exact replacement as additions. */
export function diffLinesFromEdit(oldText: string | null, newText: string | null): DiffLine[] {
  return [
    ...(oldText ? toLines(oldText).map((text): DiffLine => ({ tone: "del", text })) : []),
    ...(newText ? toLines(newText).map((text): DiffLine => ({ tone: "add", text })) : []),
  ];
}

/** Recover the patch hunks ONE step actually recorded in its code_json input:
 *  MultiEdit `edits[]`, an Edit's old/new strings, an explicit `patch`/`diff`
 *  body, or a Write's full content (all additions - the whole written body).
 *  Empty when the payload carries no patch text. */
export function hunksFromStep(step: ApiStep): DiffHunk[] {
  const input = asRecord(asRecord(parseStepCode(step))?.input);
  if (!input) return [];

  if (Array.isArray(input.edits)) {
    const hunks: DiffHunk[] = [];
    for (const raw of input.edits) {
      const edit = asRecord(raw);
      if (!edit) continue;
      const lines = diffLinesFromEdit(
        str(edit.old_string ?? edit.oldString),
        str(edit.new_string ?? edit.newString),
      );
      if (lines.length > 0) hunks.push(lines);
    }
    return hunks;
  }

  const oldText = str(input.old_string ?? input.oldString);
  const newText = str(input.new_string ?? input.newString);
  if (oldText !== null || newText !== null) {
    const lines = diffLinesFromEdit(oldText, newText);
    return lines.length > 0 ? [lines] : [];
  }

  const patch = str(input.patch ?? input.diff);
  if (patch) return [parsePatchLines(patch)];

  const content = str(input.content ?? input.code);
  if (content) return [toLines(content).map((text): DiffLine => ({ tone: "add", text }))];

  return [];
}

/** Per-file patch hunks across a run's steps, keyed by full path, in step
 *  order. Mirrors the changed-files adapter's attribution rule: a step's patch
 *  is attributed only when the step names exactly ONE file (a multi-file
 *  payload's body cannot be split honestly). */
export function filePatchesFromSteps(steps: readonly ApiStep[]): Map<string, DiffHunk[]> {
  const byPath = new Map<string, DiffHunk[]>();
  for (const step of steps) {
    const trace = deriveTrace(step);
    if (trace.glyph !== "edit" && trace.glyph !== "write") continue;
    const [entry, ...rest] = parseFileEntries(step);
    if (!entry || rest.length > 0) continue;
    const hunks = hunksFromStep(step);
    if (hunks.length === 0) continue;
    const prior = byPath.get(entry.path);
    if (prior) prior.push(...hunks);
    else byPath.set(entry.path, [...hunks]);
  }
  return byPath;
}

// ── Presentation ────────────────────────────────────────────────────────────

const LINE_TONE: Record<DiffLineTone, string> = {
  add: "bg-lime-500/10",
  del: "bg-red-500/10",
  context: "",
  meta: "bg-background-secondary-default text-text-tertiary",
};

const MARKER: Record<DiffLineTone, string> = { add: "+", del: "-", context: " ", meta: " " };

const MARKER_TONE: Record<DiffLineTone, string> = {
  add: "text-lime-600",
  del: "text-text-error-primary",
  context: "text-text-tertiary",
  meta: "text-text-tertiary",
};

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div className={cn("flex gap-2 px-3 font-mono text-[11px] leading-5", LINE_TONE[line.tone])}>
      <span aria-hidden className={cn("w-2.5 shrink-0 select-none", MARKER_TONE[line.tone])}>
        {MARKER[line.tone]}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-text-secondary">
        {line.text || " "}
      </span>
    </div>
  );
}

/** Presentational list of toned diff lines, sharing the run diff surface's exact
 *  grammar (gutter markers + add/del/context tones). Reused by the workpiece
 *  proposal review so an agent-proposed change reads the same as a run edit. */
export function DiffLines({ lines }: { readonly lines: readonly DiffLine[] }) {
  return (
    <div className="py-1">
      {lines.map((line, index) => (
        <DiffLineRow key={index} line={line} />
      ))}
    </div>
  );
}

function badgeKind(kind: string | undefined): FileChangeKind {
  return kind === "add" || kind === "delete" ? kind : "edit";
}

const FileDiffSection = memo(function FileDiffSection(props: {
  file: ChangedFile;
  hunks: readonly DiffHunk[];
  expanded: boolean;
  onToggle: (path: string) => void;
  sectionRef: (path: string, element: HTMLElement | null) => void;
}) {
  const { file, hunks, expanded, onToggle, sectionRef } = props;
  const stat =
    typeof file.additions === "number" && typeof file.deletions === "number"
      ? { additions: file.additions, deletions: file.deletions }
      : null;
  return (
    <section
      ref={(element) => sectionRef(file.path, element)}
      data-diff-file={file.path}
      className="overflow-hidden rounded-10 border border-border-button-default"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(file.path)}
        className="flex w-full cursor-pointer items-center gap-2 bg-background-secondary-default px-2.5 py-2 text-left transition-colors hover:bg-background-tertiary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
      >
        <RiArrowRightSLine
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-text-tertiary transition-transform",
            expanded && "rotate-90",
          )}
        />
        <FileKindBadge kind={badgeKind(file.kind)} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary"
          title={file.path}
        >
          {file.path}
        </span>
        {stat && hasNonZeroStat(stat) && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={stat.additions} deletions={stat.deletions} layout="inline" />
          </span>
        )}
      </button>
      {/* Collapsed sections keep their (potentially huge) bodies out of the DOM. */}
      {expanded &&
        (hunks.length > 0 ? (
          <div className="divide-y divide-border-button-default/60 border-t border-border-button-default">
            {hunks.map((hunk, hunkIndex) => (
              <div key={hunkIndex} className="py-1">
                {hunk.map((line, lineIndex) => (
                  <DiffLineRow key={lineIndex} line={line} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p
            data-testid="diff-no-patch"
            className="border-t border-border-button-default px-3 py-2 text-caption-1-regular text-text-tertiary"
          >
            Patch content not recorded for this change; only the file receipt and line stats are
            available.
          </p>
        ))}
    </section>
  );
});

/**
 * The real Diff surface: the T3 changed-files card as the index over per-file
 * collapsible unified-diff sections. Feed `files` from changedFilesFromTimeline
 * (./adapter.ts) and `patches` from filePatchesFromSteps above.
 */
export function FileDiffView({
  files,
  patches,
}: {
  files: ReadonlyArray<ChangedFile>;
  patches: ReadonlyMap<string, readonly DiffHunk[]>;
}) {
  // Unlisted paths render expanded, so a small change set opens ready to read
  // while a big one starts folded (the perf rule: never O(all-files) DOM up
  // front) - and files streaming in later arrive expanded (live follow).
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        files.length > CHANGED_FILES_AUTO_EXPAND_FILE_LIMIT ? files.map((f) => f.path) : [],
      ),
  );
  const sections = useRef(new Map<string, HTMLElement>());

  const registerSection = useCallback((path: string, element: HTMLElement | null) => {
    if (element) sections.current.set(path, element);
    else sections.current.delete(path);
  }, []);

  const toggleSection = useCallback((path: string) => {
    setCollapsedPaths((prior) => {
      const next = new Set(prior);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Index card affordance: jump to (and open) that file's diff section.
  const openFile = useCallback(
    (path?: string) => {
      if (!path) return;
      setCollapsedPaths((prior) => {
        if (!prior.has(path)) return prior;
        const next = new Set(prior);
        next.delete(path);
        return next;
      });
      sections.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [],
  );

  if (files.length === 0) return null;

  return (
    <div data-session-ui="file-diff-view" className="space-y-3 p-3 pt-0">
      <ChangedFilesCard files={files} showCompactPreview={false} onOpenFile={openFile} />
      {files.map((file) => (
        <FileDiffSection
          key={file.path}
          file={file}
          hunks={patches.get(file.path) ?? []}
          expanded={!collapsedPaths.has(file.path)}
          onToggle={toggleSection}
          sectionRef={registerSection}
        />
      ))}
    </div>
  );
}
