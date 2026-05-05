"use client";

import { useState } from "react";
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiFileCodeLine,
  RiFileLine,
  RiFileTextLine,
  RiGitBranchLine,
  RiImageLine,
  RiReactjsLine,
  RiSparkling2Line,
  RiTerminalBoxLine,
  RiTerminalLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import { cnExt as cn } from "@/utils/cn";
import { ToolChip } from "@/components/ai/tool-chips";
import {
  formatDuration,
  parseCommandStep,
  parseFileEntries,
  type ApiStep,
  type FileChangeKind,
  type FileEntry,
} from "@/components/chat/types";

// ── Shared bits ──────────────────────────────────────────────────────────────

function iconForStep(step: ApiStep): RemixiconComponentType {
  if (step.kind === "file") return RiFileCodeLine;
  if (step.kind === "task") return RiSparkling2Line;
  if (step.chip === "git") return RiGitBranchLine;
  return RiTerminalBoxLine;
}

type RowState = "running" | "done";

/**
 * Dispatches a run step to the right conversation element: command steps become
 * terminal-style tool cards, file steps become file-list cards, and everything
 * else (task / thinking) stays a compact single-line row. Never dumps raw JSON.
 */
export function ToolStepRow({
  step,
  state,
}: {
  step: ApiStep;
  state: RowState;
}) {
  if (step.kind === "command") return <CommandCard step={step} state={state} />;
  if (step.kind === "file") {
    const entries = parseFileEntries(step);
    if (entries.length > 0) return <FileCard entries={entries} />;
  }
  return <TaskRow step={step} state={state} />;
}

// ── Task / thinking row (single line) ────────────────────────────────────────

function TaskRow({ step, state }: { step: ApiStep; state: RowState }) {
  const Icon = iconForStep(step);
  const running = state === "running";
  return (
    <div className="animate-ai-fade-up flex items-center gap-2">
      <Icon
        className={cn(
          "size-4 shrink-0",
          running ? "text-blue-500" : "text-text-soft-400",
        )}
        aria-hidden
      />
      <span className="text-label-sm text-text-strong-950 min-w-0 flex-1 truncate">
        {step.label}
      </span>
      {step.chip && step.chip !== step.kind ? (
        <ToolChip
          icon={Icon}
          label={step.chip}
          state={running ? "running" : "done"}
          className="shrink-0"
        />
      ) : (
        running && (
          <span className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full" />
        )
      )}
    </div>
  );
}

// ── Command card ─────────────────────────────────────────────────────────────

function ExitBadge({ code }: { code: number }) {
  const ok = code === 0;
  const Icon = ok ? RiCheckLine : RiCloseLine;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-label-xs tabular-nums",
        ok
          ? "bg-success-lighter text-success-base"
          : "bg-error-lighter text-error-base",
      )}
    >
      <Icon className="size-3" aria-hidden />
      {code}
    </span>
  );
}

function CommandCard({ step, state }: { step: ApiStep; state: RowState }) {
  const { command, exitCode, output, durationMs } = parseCommandStep(step);
  const [open, setOpen] = useState(false);
  const running = state === "running";
  const hasOutput = Boolean(output);

  return (
    <div className="animate-ai-fade-up border-stroke-soft-200 bg-bg-weak-50 overflow-hidden rounded-xl border">
      {/* Command line */}
      <div className="flex items-center gap-2 px-2.5 py-2">
        <RiTerminalLine className="text-text-soft-400 size-4 shrink-0" aria-hidden />
        <code className="text-label-sm text-text-strong-950 min-w-0 flex-1 truncate font-mono">
          <span className="text-text-soft-400 mr-1 select-none">$</span>
          {command}
        </code>
        {typeof durationMs === "number" && (
          <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
            {formatDuration(durationMs)}
          </span>
        )}
        {typeof exitCode === "number" ? (
          <ExitBadge code={exitCode} />
        ) : (
          running && (
            <span className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full" />
          )
        )}
      </div>

      {/* Output disclosure */}
      {hasOutput && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="border-stroke-soft-200 text-text-sub-600 hover:bg-bg-soft-200 flex w-full items-center gap-1.5 border-t px-2.5 py-1.5 text-label-xs transition-colors"
          >
            <RiArrowDownSLine
              className={cn(
                "size-3.5 shrink-0 transition-transform duration-200",
                open && "rotate-180",
              )}
              aria-hidden
            />
            {open ? "Hide output" : "Show output"}
          </button>
          {open && (
            <div className="max-h-64 overflow-auto bg-neutral-950 px-3 py-2">
              <pre className="whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-[12px] leading-5 text-neutral-300">
                {output}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── File card ────────────────────────────────────────────────────────────────

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
    <span
      className={cn(
        "shrink-0 rounded-md px-1.5 py-0.5 text-label-xs",
        KIND_TONE[kind],
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

function FileRow({ entry }: { entry: FileEntry }) {
  const Icon = fileTypeIcon(entry.base);
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5">
      <Icon className="text-text-soft-400 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-label-sm">
        <span className="text-text-strong-950 font-medium">{entry.base}</span>
        {entry.dir && (
          <span className="text-text-soft-400 ml-1.5 font-mono text-label-xs">
            {entry.dir}
          </span>
        )}
      </span>
      <FileKindBadge kind={entry.kind} />
    </div>
  );
}

function FileCard({ entries }: { entries: FileEntry[] }) {
  return (
    <div className="animate-ai-fade-up border-stroke-soft-200 bg-bg-weak-50 divide-stroke-soft-200 overflow-hidden rounded-xl border">
      {entries.length > 1 && (
        <div className="border-stroke-soft-200 text-mono-label text-text-soft-400 border-b px-2.5 py-1.5">
          {entries.length} files
        </div>
      )}
      <div className="divide-stroke-soft-200 divide-y">
        {entries.map((entry, i) => (
          <FileRow key={`${entry.path}-${i}`} entry={entry} />
        ))}
      </div>
    </div>
  );
}
