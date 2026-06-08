// Ported from the beautiful-ui Tool Chips demo (upstream refresh, Aug 2026;
// hardcoded → parameterized) onto our semantic tokens and Remixicon. An agent
// run folded into compact rows: a "N tool calls" disclosure header, tool rows
// whose leading icon morphs into a chevron on hover and expand to detail
// lines, then file-diff chips that preview their diff on hover. The upstream
// body portal and timed reveal choreography are intentionally not ported; the
// diff preview anchors to its chip instead.
"use client";

import { RiArrowDownSLine } from "@remixicon/react";
import type { ComponentType } from "react";
import { useState } from "react";
import { cx } from "@/utils/cx";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface ToolCallDetailLine {
  text: string;
  tone?: "add";
}

export interface ToolCallRow {
  icon: IconComponent;
  label: string;
  /** Inline chip after the label - the tool's subject (file, command, note). */
  chip: string;
  /** Render the chip in the mono face (commands, file names). */
  mono?: boolean;
  /** Render the detail lines in the mono face. */
  detailMono?: boolean;
  detail: ToolCallDetailLine[];
}

export interface FileDiffLine {
  text: string;
  tone: "add" | "del" | "ctx";
}

export interface FileDiffStat {
  file: string;
  add: number;
  del: number;
  /** Diff body shown in the hover preview. */
  lines?: FileDiffLine[];
}

export interface ToolCallFoldProps {
  /** Header line, e.g. "4 tool calls, 2 messages". */
  summary: string;
  rows: ToolCallRow[];
  diffs?: FileDiffStat[];
  /** Trailing overflow affordance after the diff chips, e.g. "+2 more". */
  moreLabel?: string;
  defaultOpen?: boolean;
  className?: string;
}

const diffLineTone: Record<FileDiffLine["tone"], string> = {
  add: "bg-status-lime-background text-lime-600",
  del: "bg-status-rose-background text-text-error-primary",
  ctx: "text-text-secondary",
};

function DiffChip({ diff }: { diff: FileDiffStat }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Show diff for ${diff.file}`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex h-7 max-w-full items-center gap-2 rounded-md border border-border-button-default bg-background-primary-default px-2 font-mono text-caption-1-regular text-text-primary transition-colors duration-100 hover:bg-background-primary-hover"
      >
        <span className="min-w-0 truncate">{diff.file}</span>
        <span className="shrink-0 text-lime-600 tabular-nums">+{diff.add}</span>
        {diff.del > 0 && (
          <span className="shrink-0 text-text-error-primary tabular-nums">−{diff.del}</span>
        )}
      </button>

      {open && diff.lines && diff.lines.length > 0 && (
        <div className="absolute top-full left-0 z-20 mt-1.5 w-72 overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default shadow-dropdown">
          <div className="flex items-center justify-between border-b border-border-button-default px-2.5 py-1.5 font-mono text-caption-1-regular">
            <span className="min-w-0 truncate text-text-secondary">{diff.file}</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-lime-600">+{diff.add}</span>
              {diff.del > 0 && <span className="text-text-error-primary"> −{diff.del}</span>}
            </span>
          </div>
          <div className="py-1 font-mono text-caption-1-regular leading-[1.8]">
            {diff.lines.map((line, index) => (
              // Lines are a static ordered list; index keys are stable.
              <div
                key={index}
                className={cx("flex gap-2 px-2.5 whitespace-pre", diffLineTone[line.tone])}
              >
                <span className="w-3 shrink-0 select-none">
                  {line.tone === "add" ? "+" : line.tone === "del" ? "−" : " "}
                </span>
                <span className="min-w-0 truncate">{line.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

function FoldRow({ row }: { row: ToolCallRow }) {
  const [open, setOpen] = useState(false);
  const RowIcon = row.icon;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="group/row -mx-[3px] flex h-8 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-md px-[3px] text-left transition-colors duration-100 hover:bg-background-secondary-hover"
      >
        {/* Leading icon morphs into the expand chevron on hover / while open. */}
        <span className="relative flex size-4 shrink-0 items-center justify-center text-text-tertiary">
          <RowIcon
            className={cx(
              "size-3.5 transition-opacity duration-100 group-hover/row:opacity-0",
              open && "opacity-0",
            )}
            aria-hidden
          />
          <RiArrowDownSLine
            className={cx(
              "absolute size-3.5 opacity-0 transition-[opacity,transform] duration-150 group-hover/row:opacity-100",
              open ? "rotate-0 opacity-100" : "-rotate-90",
            )}
            aria-hidden
          />
        </span>
        <span className="shrink-0 text-body-2-medium text-text-primary">{row.label}</span>
        <span
          className={cx(
            "inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-md bg-background-secondary-default px-1.5 text-caption-1-regular text-text-secondary transition-colors duration-100",
            row.mono && "font-mono",
          )}
        >
          {row.chip}
        </span>
      </button>

      {/* Expanded detail */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-border-button-default py-0.5 pl-3.5">
            {row.detail.map((line) => (
              <span
                key={line.text}
                className={cx(
                  "truncate text-caption-1-regular leading-[1.6]",
                  row.detailMono && "font-mono",
                  line.tone === "add" ? "text-lime-600" : "text-text-secondary",
                )}
              >
                {line.text}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ToolCallFold({
  summary,
  rows,
  diffs,
  moreLabel,
  defaultOpen = true,
  className,
}: ToolCallFoldProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cx("w-full", className)}>
      {/* Collapsed run header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-body-2-regular text-text-secondary transition-colors duration-100 hover:bg-background-secondary-hover"
      >
        <RiArrowDownSLine
          className={cx("size-3.5 transition-transform duration-200", !open && "-rotate-90")}
          aria-hidden
        />
        <span className="tabular-nums">{summary}</span>
      </button>

      {/* Tool call rows */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        {/* -mx-1 + px-1.5 keeps content at the same x while giving the row
            hover pills room inside this overflow-hidden clip box. */}
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
          <div className="mt-1.5 flex flex-col gap-1">
            {rows.map((row) => (
              <FoldRow key={row.label} row={row} />
            ))}
          </div>

          {/* File-diff chips */}
          {diffs && diffs.length > 0 && (
            <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-border-button-default pt-2.5">
              {diffs.map((diff) => (
                <DiffChip key={diff.file} diff={diff} />
              ))}
              {moreLabel && (
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-md px-1.5 font-mono text-caption-1-regular text-text-tertiary underline decoration-transparent underline-offset-2 transition-colors duration-100 hover:text-text-secondary hover:decoration-current"
                >
                  {moreLabel}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
