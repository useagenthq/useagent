"use client";

// The ONE block a turn's work renders as, in every thread: a Thinking header
// ("Thinking" + the pixel loader while live, "Thought for 1m 12s" or "4 tool
// calls, 2 messages" once settled) over short step lines behind a hairline
// rule. A step line is: a muted check when done (an x when failed, the loader
// while it runs), the step's family glyph, a verb-first label, the object it
// acted on in a chip (mono for a command, a path or a slug), and a muted
// detail. A step opens in place to its payload (reasoning prose, a tool's
// command + output), which mounts only then. What the agent said mid-work is
// a muted prose line between the steps, with no verb and no chip. When the
// turn edited files, a strip of file chips with +added / -removed counts
// closes the list. Rows are memoized and a long trace keeps only its newest
// rows in the DOM until asked. The containing turn owns the open state, so
// virtualized remounts preserve it; bot threads start folded. Row grammar from
// the beautiful-ui Tool Chips demo, header grammar from its Thinking demo, on
// our semantic tokens.

import { RiArrowDownSLine, RiCheckLine, RiCloseLine } from "@remixicon/react";
import { memo, useState } from "react";
import { PixelLoader } from "@/components/ai/loading-state";
import { Thinking } from "@/components/ai/thinking";
import { STEP_ICON } from "@/components/chat/step-icons";
import { useTurnUiState } from "@/components/chat/turn-ui-state";
import { basename } from "@/components/chat/types";
import { Markdown } from "@/components/prompt-kit/markdown";
import type { ChangedFile } from "@/components/session-ui/changed-files";
import { MessageCopyButton } from "@/components/session-ui/message-copy-button";
import { buildToolCallExpandedBody } from "@/components/session-ui/work-entry";
import { cx as cn } from "@/utils/cx";
import type {
  TraceHeader,
  TraceNarrationRow,
  TraceRow,
  TraceRowBody,
  TraceRowStatus,
  TraceStepRow,
} from "./turn-trace-model";

/** Rows an open trace shows before folding the earlier ones behind one line. */
export const MAX_VISIBLE_TRACE_ROWS = 24;

/** File chips shown before the "+N more" tail. */
const MAX_VISIBLE_CHANGED_FILES = 3;

function StatusGlyph({ status }: { status: TraceRowStatus }) {
  const label = status === "failed" ? "Failed" : status === "running" ? "Running" : "Completed";
  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center"
      role="img"
      aria-label={label}
      title={label}
    >
      {status === "running" ? (
        <PixelLoader size="sm" className="text-text-secondary" />
      ) : status === "failed" ? (
        <RiCloseLine className="size-3.5 text-text-error-primary" aria-hidden />
      ) : (
        <RiCheckLine className="size-3.5 text-text-tertiary" aria-hidden />
      )}
    </span>
  );
}

/** The opened row's payload. Built here, on open, never up front. */
export function TraceRowPayload({ body }: { body: TraceRowBody }) {
  if (body.kind === "prose") {
    return (
      <div className="mb-1 ml-12 mt-0.5 pr-2" data-testid="trace-row-prose">
        <Markdown className="text-body-2-regular text-text-secondary">{body.text}</Markdown>
      </div>
    );
  }
  if (body.kind === "failure") {
    // The failed run's reason, every character of it, verbatim (never markdown)
    // and copyable: the header and the row only fit its first line.
    return (
      <div
        className="mb-1 ml-12 mt-0.5 flex items-start gap-2 border-s border-border-button-default ps-3"
        data-testid="trace-row-failure"
      >
        <pre className="min-w-0 flex-1 cursor-text select-text whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary">
          {body.reason}
        </pre>
        <MessageCopyButton text={body.reason} label="Copy error" />
      </div>
    );
  }
  const text = buildToolCallExpandedBody(body.entry, undefined);
  if (!text) return null;
  return (
    <div
      className="mb-1 ml-12 mt-0.5 border-s border-border-button-default ps-3"
      data-testid="trace-row-output"
    >
      <pre className="max-h-64 cursor-text select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary">
        {text}
      </pre>
    </div>
  );
}

/** A mid-work narration burst: the prose itself, muted, in the payload column.
 *  No verb, no chip, nothing to open; it folds with the trace. */
const TraceNarrationLine = memo(function TraceNarrationLine({ row }: { row: TraceNarrationRow }) {
  return (
    <div data-testid="trace-narration" className="ml-12 py-1 pr-2">
      <Markdown className="text-[12.5px] leading-5 text-text-tertiary">{row.text}</Markdown>
    </div>
  );
});

const TraceRowView = memo(function TraceRowView({ row }: { row: TraceStepRow }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = STEP_ICON[row.family];
  const expandable = row.body !== null;
  const head = (
    <>
      <StatusGlyph status={row.status} />
      <Icon className="size-3.5 shrink-0 text-text-tertiary opacity-80" aria-hidden />
      <span
        data-testid="trace-row-label"
        className={cn(
          "shrink-0 text-[12.5px] font-medium leading-5",
          row.status === "failed" ? "text-text-error-primary" : "text-text-primary",
        )}
      >
        {row.label}
      </span>
      {row.chip && (
        <span
          data-testid="trace-row-chip"
          className={cn(
            "inline-flex h-[22px] min-w-0 shrink items-center truncate rounded-md bg-background-secondary-default px-1.5 text-[11.5px] text-text-secondary ring-1 ring-inset ring-border-button-default/60",
            row.chip.mono && "font-mono",
          )}
        >
          <span className="truncate">{row.chip.text}</span>
        </span>
      )}
      {row.detail && (
        <span className="min-w-0 shrink-[3] truncate text-[11.5px] tabular-nums text-text-tertiary">
          {row.detail}
        </span>
      )}
      {expandable && (
        <RiArrowDownSLine
          className={cn(
            "ml-auto size-3.5 shrink-0 text-text-tertiary opacity-70 transition-transform duration-200",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      )}
    </>
  );
  const rowClass = "flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left";

  return (
    <div data-testid="trace-row" data-status={row.status} data-family={row.family}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className={cn(
            rowClass,
            "cursor-pointer transition-colors duration-150 hover:bg-background-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
          )}
        >
          {head}
        </button>
      ) : (
        <div className={rowClass}>{head}</div>
      )}
      {expanded && row.body && <TraceRowPayload body={row.body} />}
    </div>
  );
});

/** The files this turn changed, as mono chips with their honest line counts
 *  (a step that exposes no diff renders the name alone). */
function ChangedFilesStrip({ files }: { files: readonly ChangedFile[] }) {
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, files.length - MAX_VISIBLE_CHANGED_FILES);
  const visible = hidden > 0 ? files.slice(0, MAX_VISIBLE_CHANGED_FILES) : files;
  return (
    <div
      data-testid="trace-changed-files"
      className="mt-2 flex max-w-full flex-wrap items-center gap-1.5 border-t border-border-button-default/60 pt-2.5"
    >
      {visible.map((file) => (
        <span
          key={file.path}
          title={file.path}
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md bg-background-primary-default px-2 font-mono text-[11.5px] text-text-primary ring-1 ring-inset ring-border-button-default"
        >
          <span className="min-w-0 truncate">{basename(file.path)}</span>
          {typeof file.additions === "number" && (
            <span className="shrink-0 text-success-base tabular-nums">+{file.additions}</span>
          )}
          {typeof file.deletions === "number" && file.deletions > 0 && (
            <span className="shrink-0 text-text-error-primary tabular-nums">-{file.deletions}</span>
          )}
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="inline-flex h-7 items-center rounded-md px-1.5 font-mono text-[11.5px] text-text-tertiary underline decoration-transparent underline-offset-2 transition-colors hover:text-text-secondary hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
        >
          +{hidden} more
        </button>
      )}
    </div>
  );
}

export function TurnTrace({
  rows,
  header,
  files = [],
  live,
  defaultOpen,
}: {
  rows: readonly TraceRow[];
  header: TraceHeader;
  /** The files the turn's edit/write steps touched (adapter changedFilesFromTimeline). */
  files?: readonly ChangedFile[];
  live: boolean;
  /** Plain threads open; a bot's thread starts folded (its reply is the block). */
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useTurnUiState("trace", defaultOpen);
  const [showAll, setShowAll] = useTurnUiState("trace-all", false);
  const hidden = showAll ? 0 : Math.max(0, rows.length - MAX_VISIBLE_TRACE_ROWS);
  const visible = hidden > 0 ? rows.slice(hidden) : rows;

  return (
    <section
      data-testid="turn-trace"
      data-live={live ? "true" : undefined}
      aria-label={header.label}
    >
      <Thinking
        label={header.label}
        detail={header.detail}
        active={live}
        failed={header.failed}
        expanded={open}
        onExpandedChange={setOpen}
      >
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex min-h-7 w-fit items-center rounded-md px-1.5 py-0.5 text-[12px] text-text-tertiary transition-colors hover:bg-background-primary-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
          >
            Show {hidden} earlier {hidden === 1 ? "step" : "steps"}
          </button>
        )}
        {visible.map((row) =>
          row.kind === "narration" ? (
            <TraceNarrationLine key={row.key} row={row} />
          ) : (
            <TraceRowView key={row.key} row={row} />
          ),
        )}
        {files.length > 0 && <ChangedFilesStrip files={files} />}
      </Thinking>
    </section>
  );
}
