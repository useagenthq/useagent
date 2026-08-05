"use client";

import { useState } from "react";
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiFileAddLine,
  RiFileCodeLine,
  RiFileEditLine,
  RiFileLine,
  RiFileTextLine,
  RiGlobalLine,
  RiImageLine,
  RiListCheck,
  RiReactjsLine,
  RiRobot2Line,
  RiSearchLine,
  RiServerLine,
  RiSparkling2Line,
  RiTerminalLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import {
  deriveTrace,
  formatDuration,
  type ApiStep,
  type FileChangeKind,
  type StepTrace,
  type TraceGlyph,
} from "@/components/chat/types";

type RowState = "running" | "done";

/**
 * A single worklog step, rendered in the beautiful-ui trace grammar: a bold
 * leading verb (Read / Edit / Write / Run / Search / Subagent / Sandbox …), a
 * monospace target (basename or command), an optional derived `+adds -dels`, and
 * — when the step carries output or a prompt — a click-to-expand mono block.
 * Everything is re-derived from `code_json` on each render, so an in-place step
 * update (enriched with output mid-run) re-reads without memo staleness.
 */
export function ToolStepRow({ step, state }: { step: ApiStep; state: RowState }) {
  return <TraceRow trace={deriveTrace(step)} state={state} />;
}

// ── Icons ────────────────────────────────────────────────────────────────────

const GLYPH_ICON: Record<TraceGlyph, RemixiconComponentType> = {
  read: RiFileTextLine,
  edit: RiFileEditLine,
  write: RiFileAddLine,
  run: RiTerminalLine,
  search: RiSearchLine,
  list: RiListCheck,
  fetch: RiGlobalLine,
  subagent: RiRobot2Line,
  reasoning: RiSparkling2Line,
  task: RiSparkling2Line,
  boot: RiServerLine,
};

/** File-shaped rows prefer an extension-aware glyph over the generic family one. */
function iconForTrace(trace: StepTrace): RemixiconComponentType {
  if (trace.base && (trace.glyph === "read" || trace.glyph === "edit" || trace.glyph === "write")) {
    return fileTypeIcon(trace.base);
  }
  return GLYPH_ICON[trace.glyph];
}

// ── Trace row ────────────────────────────────────────────────────────────────

function ExitBadge({ code }: { code: number }) {
  const ok = code === 0;
  const Icon = ok ? RiCheckLine : RiCloseLine;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-label-xs tabular-nums",
        ok ? "bg-success-lighter text-success-base" : "bg-error-lighter text-error-base",
      )}
    >
      <Icon className="size-3" aria-hidden />
      {code}
    </span>
  );
}

function DiffStat({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span className="shrink-0 font-mono text-label-xs tabular-nums" aria-label={`+${adds} -${dels}`}>
      <span className="text-success-base">+{adds}</span>{" "}
      <span className="text-error-base">−{dels}</span>
    </span>
  );
}

function TraceRow({ trace, state }: { trace: StepTrace; state: RowState }) {
  const [open, setOpen] = useState(false);
  const running = state === "running";
  const Icon = iconForTrace(trace);
  const expandable = Boolean(trace.detail);
  const subagent = trace.accent === "subagent";
  const showRunningDot = running && trace.exitCode === null;

  const head = (
    <>
      {subagent ? (
        <span className="bg-feature-lighter text-feature-base flex size-5 shrink-0 items-center justify-center rounded-md">
          <Icon className="size-3.5" aria-hidden />
        </span>
      ) : (
        <Icon
          className={cn(
            "size-4 shrink-0",
            trace.accent === "boot"
              ? "text-text-soft-400"
              : running
                ? "text-blue-500"
                : "text-text-soft-400",
          )}
          aria-hidden
        />
      )}

      <span className="min-w-0 flex-1 truncate">
        <span
          className={cn(
            "text-label-sm font-medium",
            subagent ? "text-feature-base" : "text-text-strong-950",
          )}
        >
          {trace.verb}
        </span>
        {trace.target && (
          <span
            className={cn(
              "ml-1.5",
              trace.monoTarget
                ? "text-text-sub-600 font-mono text-label-xs"
                : "text-text-sub-600 text-label-sm",
            )}
          >
            {trace.target}
          </span>
        )}
      </span>

      {trace.adds !== null && trace.dels !== null && (
        <DiffStat adds={trace.adds} dels={trace.dels} />
      )}
      {typeof trace.durationMs === "number" && (
        <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
          {formatDuration(trace.durationMs)}
        </span>
      )}
      {trace.exitCode !== null ? (
        <ExitBadge code={trace.exitCode} />
      ) : (
        showRunningDot && (
          <span className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full" />
        )
      )}
      {expandable && (
        <RiArrowDownSLine
          className={cn(
            "text-text-soft-400 size-4 shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      )}
    </>
  );

  return (
    <div
      className={cn(
        "animate-ai-fade-up",
        trace.nested && "border-stroke-soft-200 ml-2 border-l pl-3",
      )}
    >
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="hover:bg-bg-weak-50 flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors"
        >
          {head}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-1.5 py-1">{head}</div>
      )}

      {expandable && open && trace.detail && (
        <div className="mt-1 ml-1.5 max-h-64 overflow-auto rounded-lg bg-neutral-950 px-3 py-2">
          <pre className="whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-[12px] leading-5 text-neutral-300">
            {trace.detail}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── File helpers (shared with the editor pane) ───────────────────────────────

/** Remix icon for a file, chosen by extension. Shared with the editor tabs. */
export function fileTypeIcon(base: string): RemixiconComponentType {
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "tsx" || ext === "jsx") return RiReactjsLine;
  if (["md", "mdx", "txt"].includes(ext)) return RiFileTextLine;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext))
    return RiImageLine;
  if (
    ["ts", "js", "mjs", "cjs", "json", "css", "scss", "html", "py", "go", "rs", "sh", "yml", "yaml", "sql"].includes(ext)
  )
    return RiFileCodeLine;
  return RiFileLine;
}

const KIND_TONE: Record<FileChangeKind, string> = {
  add: "bg-success-lighter text-success-base",
  edit: "bg-information-lighter text-information-base",
  delete: "bg-error-lighter text-error-base",
};
const KIND_LABEL: Record<FileChangeKind, string> = {
  add: "add",
  edit: "edit",
  delete: "del",
};

/** Colored add/edit/del pill. Shared by the file card and the editor pane. */
export function FileKindBadge({ kind }: { kind: FileChangeKind }) {
  return (
    <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-label-xs", KIND_TONE[kind])}>
      {KIND_LABEL[kind]}
    </span>
  );
}
