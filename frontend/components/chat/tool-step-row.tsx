"use client";

import { memo, useState } from "react";
import {
  RiArrowDownSLine,
  RiBookMarkedLine,
  RiBookOpenLine,
  RiCheckboxCircleFill,
  RiCheckboxBlankCircleLine,
  RiCheckLine,
  RiCloseLine,
  RiDatabase2Line,
  RiErrorWarningLine,
  RiFileAddLine,
  RiFlashlightLine,
  RiFileCodeLine,
  RiFileEditLine,
  RiFileLine,
  RiFileTextLine,
  RiGlobalLine,
  RiImageLine,
  RiIndeterminateCircleLine,
  RiListCheck,
  RiLoader4Line,
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
  parseTodos,
  type ApiStep,
  type FileChangeKind,
  type StepTrace,
  type TodoItem,
  type TodoStatus,
  type TraceGlyph,
} from "@/components/chat/types";
import type { TimelineMarker } from "@/components/chat/timeline";

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
  return (
    <TraceRow
      trace={nested === undefined ? trace : { ...trace, nested }}
      state={state}
    />
  );
});

// ── Canonical context markers (skill.loaded / context.retrieved) ─────────────

/** Visual model for one marker row — same row anatomy as a trace row, tinted with
 *  the `feature` accent so context markers read distinctly from tool calls. */
function markerView(marker: TimelineMarker): {
  Icon: RemixiconComponentType;
  verb: string;
  target: string;
  badge: string | null;
  error: boolean;
} {
  if (marker.kind === "skill") {
    return {
      Icon: marker.playbook ? RiBookMarkedLine : RiFlashlightLine,
      verb: marker.playbook ? "Playbook" : "Skill",
      target: marker.name,
      badge: `v${marker.version}`,
      error: false,
    };
  }
  if (marker.kind === "memory") {
    const pool = marker.scope === "personal" ? "personal memory" : "organization memory";
    if (marker.failed) {
      // Honest write failure - distinct from a 0-hit recall, never a fake save.
      const what =
        marker.op === "correct"
          ? "update failed"
          : marker.op === "forget"
            ? "delete failed"
            : "not saved";
      return {
        Icon: RiErrorWarningLine,
        verb: "Memory",
        target: `${what} (service unavailable)`,
        badge: null,
        error: true,
      };
    }
    if (marker.op === "correct") {
      return { Icon: RiDatabase2Line, verb: "Updated", target: pool, badge: null, error: false };
    }
    if (marker.op === "forget") {
      return { Icon: RiDatabase2Line, verb: "Forgot", target: `from ${pool}`, badge: null, error: false };
    }
    // remember: L0 write is durable + searchable now; L1 distillation is async
    // and unobserved during the turn, so "indexing" is the terminal badge.
    return {
      Icon: RiDatabase2Line,
      verb: "Remembered",
      target: `in ${pool}`,
      badge: marker.reconciled ? "already saved" : "indexing",
      error: false,
    };
  }
  const known = marker.source === "knowledge" || marker.source === "memory";
  const label = known ? marker.source : "context";
  const n = marker.itemCount;
  return {
    Icon: marker.source === "knowledge" ? RiBookOpenLine : RiDatabase2Line,
    verb: "Recalled",
    target: `${n} ${n === 1 ? "item" : "items"} from ${label}`,
    badge: null,
    error: false,
  };
}

/**
 * A canonical context marker rendered in the SHARED trace grammar (skill.loaded →
 * "Skill <name> v<n>", context.retrieved → "Recalled N items from memory"). Not a
 * parallel context pane — one typed row, feature-accented. Memoized by the marker
 * object (the timeline replaces it only when the underlying frame changes).
 */
export const MarkerRow = memo(function MarkerRow({ marker }: { marker: TimelineMarker }) {
  const { Icon, verb, target, badge, error } = markerView(marker);
  return (
    <div className="animate-ai-fade-up flex items-center gap-2 px-1.5 py-1">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-md",
          error ? "bg-error-lighter text-error-base" : "bg-feature-lighter text-feature-base",
        )}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span
          className={cn(
            "text-label-sm font-medium",
            error ? "text-error-base" : "text-feature-base",
          )}
        >
          {verb}
        </span>
        {target && <span className="text-text-sub-600 ml-1.5 text-label-sm">{target}</span>}
      </span>
      {badge && (
        <span className="text-text-soft-400 shrink-0 font-mono text-label-xs tabular-nums">
          {badge}
        </span>
      )}
    </div>
  );
});

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

/** Error pill for a native tool error that carries no exit code (a non-zero
 *  command exit already shows its code in an error-toned ExitBadge). */
function ErrorBadge() {
  return (
    <span className="bg-error-lighter text-error-base inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-label-xs">
      <RiErrorWarningLine className="size-3" aria-hidden />
      error
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
            trace.isError
              ? "text-error-base"
              : trace.accent === "boot"
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
        <div
          className={cn(
            "mt-1 ml-1.5 max-h-64 overflow-auto rounded-lg bg-neutral-950 px-3 py-2",
            trace.isError && "ring-error-base/40 ring-1",
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

const TODO_ICON: Record<TodoStatus, RemixiconComponentType> = {
  pending: RiCheckboxBlankCircleLine,
  in_progress: RiLoader4Line,
  completed: RiCheckboxCircleFill,
  cancelled: RiIndeterminateCircleLine,
};
const TODO_TONE: Record<TodoStatus, string> = {
  pending: "text-text-soft-400",
  in_progress: "text-blue-500",
  completed: "text-success-base",
  cancelled: "text-text-disabled-300",
};

/** The agent's plan from a `todowrite` step, rendered as a live checklist —
 *  mirrors opencode's todos part instead of collapsing it to a generic row. */
function TodoList({ todos, nested }: { todos: TodoItem[]; nested?: boolean }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div
      className={cn(
        "animate-ai-fade-up",
        nested && "border-stroke-soft-200 ml-2 border-l pl-3",
      )}
    >
      <div className="flex items-center gap-2 px-1.5 py-1">
        <RiListCheck className="text-text-soft-400 size-4 shrink-0" aria-hidden />
        <span className="text-label-sm text-text-strong-950 font-medium">Todos</span>
        <span className="text-text-soft-400 text-label-xs tabular-nums">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="ml-1.5 space-y-1 py-0.5">
        {todos.map((todo) => {
          const Icon = TODO_ICON[todo.status];
          const struck = todo.status === "completed" || todo.status === "cancelled";
          return (
            <li key={todo.content} className="flex items-start gap-2 px-1.5">
              <Icon
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  TODO_TONE[todo.status],
                  todo.status === "in_progress" && "animate-spin",
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "text-paragraph-xs",
                  struck
                    ? "text-text-soft-400 line-through"
                    : "text-text-sub-600",
                )}
              >
                {todo.content}
              </span>
            </li>
          );
        })}
      </ul>
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
