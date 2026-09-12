"use client";

import {
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiFileCodeLine,
  RiFileLine,
  RiFileTextLine,
  RiImageLine,
  RiReactjsLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import { memo, useState } from "react";
import { PlanChecklist } from "@/components/agent-ui/plan-checklist";
import { familyForGlyph, STEP_ICON } from "@/components/chat/step-icons";
import {
  type ApiStep,
  deriveTrace,
  type FileChangeKind,
  parseTodos,
  type StepTrace,
  type TodoItem,
} from "@/components/chat/types";
import { formatDuration } from "@/utils/format";
import { cx as cn } from "@/utils/cx";

type RowState = "running" | "done";

/**
 * A single worklog step, rendered in the beautiful-ui trace grammar: a bold
 * leading verb (Read / Edit / Write / Run / Search / Subagent / Sandbox …), a
 * monospace target (basename or command), an optional derived `+adds -dels`, and
 * — when the step carries output or a prompt — a click-to-expand mono block.
 * Everything is re-derived from `code_json` on each render, so an in-place step
 * update (enriched with output mid-run) re-reads without memo staleness.
 *
 * `nested` overrides the label-derived indent when a caller knows a step's real
 * ownership from native ids (the subagent pane groups by native child session);
 * omit it to keep the default "↳ "-prefix indent.
 *
 * Typed part dispatch: a `todowrite` step renders its plan as a checklist; every
 * other step renders in the trace grammar. Memoized so a fanout's per-part rows
 * don't re-render when unrelated steps update — the props are keyed by the step
 * object, which the native store replaces only when that step is enriched.
 */
export const ToolStepRow = memo(function ToolStepRow({
  step,
  state,
  nested,
}: {
  step: ApiStep;
  state: RowState;
  nested?: boolean;
}) {
  const todos = parseTodos(step);
  if (todos) return <TodoList todos={todos} nested={nested} />;
  const trace = deriveTrace(step);
  return <TraceRow trace={nested === undefined ? trace : { ...trace, nested }} state={state} />;
});

// ── Icons ────────────────────────────────────────────────────────────────────

/** File-shaped rows prefer an extension-aware glyph over the family one; every
 *  other row draws the shared step-family glyph (components/chat/step-icons). */
function iconForTrace(trace: StepTrace): RemixiconComponentType {
  if (trace.base && (trace.glyph === "read" || trace.glyph === "edit" || trace.glyph === "write")) {
    return fileTypeIcon(trace.base);
  }
  return STEP_ICON[familyForGlyph(trace.glyph)];
}

// ── Trace row ────────────────────────────────────────────────────────────────

function ExitBadge({ code }: { code: number }) {
  const ok = code === 0;
  const Icon = ok ? RiCheckLine : RiCloseLine;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-caption-1-medium tabular-nums",
        ok ? "bg-lime-100 text-lime-600" : "bg-red-50 text-red-500",
      )}
    >
      <Icon className="size-3" aria-hidden />
      {code}
    </span>
  );
}

/** Error pill for a native tool error that carries no exit code (a non-zero
 *  command exit already shows its code in an error-toned ExitBadge). */
function ErrorBadge() {
  return (
    <span className="bg-red-50 text-red-500 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-1-medium">
      <RiErrorWarningLine className="size-3" aria-hidden />
      error
    </span>
  );
}

function DiffStat({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span className="shrink-0 font-mono text-caption-1-medium tabular-nums">
      <span aria-hidden="true">
        <span className="text-lime-600">+{adds}</span>{" "}
        <span className="text-red-500">−{dels}</span>
      </span>
      <span className="sr-only">{`${adds} additions, ${dels} deletions`}</span>
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
        <Icon className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
      ) : (
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            trace.isError
              ? "text-red-500"
              : trace.accent === "boot"
                ? "text-text-tertiary"
                : running
                  ? "text-blue-500"
                  : "text-text-tertiary",
          )}
          aria-hidden
        />
      )}

      <span className="min-w-0 flex-1 truncate">
        <span
          className={cn(
            "text-caption-1-medium font-medium",
            subagent ? "text-purple-500" : "text-text-primary",
          )}
        >
          {trace.verb}
        </span>
        {trace.target && (
          <span
            className={cn(
              "ml-1.5",
              trace.monoTarget
                ? "text-text-secondary font-mono text-[11px]"
                : "text-text-secondary text-caption-1-regular",
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
        <span className="text-text-tertiary shrink-0 font-mono text-caption-1-medium tabular-nums">
          {formatDuration(trace.durationMs)}
        </span>
      )}
      {trace.exitCode !== null ? (
        <ExitBadge code={trace.exitCode} />
      ) : trace.isError ? (
        <ErrorBadge />
      ) : (
        showRunningDot && (
          <span className="ai-loading-pixel bg-blue-500 size-1.5 shrink-0 rounded-full" />
        )
      )}
      {expandable && (
        <RiArrowDownSLine
          className={cn(
            "text-text-tertiary size-4 shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      )}
    </>
  );

  return (
    <div
      data-testid="tool-row"
      data-glyph={trace.glyph}
      className={cn(
        "animate-ai-fade-up",
        trace.nested && "border-border-button-default ml-2 border-l pl-3",
      )}
    >
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="hover:bg-background-primary-hover flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
        >
          {head}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-1.5 py-0.5">{head}</div>
      )}

      {expandable && open && trace.detail && (
        <div
          className={cn(
            "mt-1 ml-1.5 max-h-64 overflow-auto rounded-lg bg-neutral-950 px-3 py-2",
            trace.isError && "ring-border-error-default/40 ring-1",
          )}
        >
          <pre className="whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-[12px] leading-5 text-neutral-300">
            {trace.detail}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Todos (opencode `todowrite`) ─────────────────────────────────────────────

/** The agent's plan from a `todowrite` step, rendered through the shared beUI
 *  Todo List card — a collapsible checklist that morphs by state instead of
 *  collapsing the plan to a generic row. Maps the durable `TodoItem` shape onto
 *  the canonical plan-entry props; content is the stable key so a live status
 *  flip transitions in place. */
function TodoList({ todos, nested }: { todos: TodoItem[]; nested?: boolean }) {
  const entries = todos.map((todo) => ({
    id: todo.id,
    text: todo.content,
    status: todo.status,
  }));
  return (
    <PlanChecklist
      title="Todos"
      entries={entries}
      testId="todo-list"
      className={cn("animate-ai-fade-up", nested && "ml-4")}
    />
  );
}

// ── File helpers (shared with the editor pane) ───────────────────────────────

/** Remix icon for a file, chosen by extension. Shared with the editor tabs. */
export function fileTypeIcon(base: string): RemixiconComponentType {
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "tsx" || ext === "jsx") return RiReactjsLine;
  if (["md", "mdx", "txt"].includes(ext)) return RiFileTextLine;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return RiImageLine;
  if (
    [
      "ts",
      "js",
      "mjs",
      "cjs",
      "json",
      "css",
      "scss",
      "html",
      "py",
      "go",
      "rs",
      "sh",
      "yml",
      "yaml",
      "sql",
    ].includes(ext)
  )
    return RiFileCodeLine;
  return RiFileLine;
}

const KIND_TONE: Record<FileChangeKind, string> = {
  add: "bg-lime-100 text-lime-600",
  edit: "bg-blue-50 text-blue-500",
  delete: "bg-red-50 text-red-500",
};
const KIND_LABEL: Record<FileChangeKind, string> = {
  add: "add",
  edit: "edit",
  delete: "del",
};

/** Colored add/edit/del pill. Shared by the file card and the editor pane. */
export function FileKindBadge({ kind }: { kind: FileChangeKind }) {
  return (
    <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-caption-1-medium", KIND_TONE[kind])}>
      {KIND_LABEL[kind]}
    </span>
  );
}
