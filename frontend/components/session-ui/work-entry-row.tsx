"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/MessagesTimeline.tsx
//   PlainWorkEntryRow + WorkEntryIconSvg + workToneIcon (the compact tool-call row:
//   icon + heading + truncated preview + expand chevron + failed/success/neutral
//   status affordance + click-to-expand mono body).
//
// Port notes:
// - lucide-react icons -> @remixicon/react (this repo's only icon set).
// - T3 shadcn tokens -> BoardUI semantic tokens (secondary-label -> text-text-secondary,
//   icon-muted -> text-text-tertiary, foreground -> text-text-primary, destructive -> error red,
//   accent hover -> background-primary-hover, border -> border-button-default). No hardcoded palette.
// - Their Tooltip -> BoardUI tooltip (react-aria; plain triggers wrapped in Focusable).
// - runtime.warning chrome dropped (no sourceActivityKind in our canonical lane yet).

import {
  type RemixiconComponentType,
  RiArrowDownSLine,
  RiChat3Line,
  RiCheckLine,
  RiCloseLine,
  RiEditBoxLine,
  RiErrorWarningLine,
  RiEyeLine,
  RiFlashlightLine,
  RiGlobalLine,
  RiHammerLine,
  RiRobot2Line,
  RiSubtractLine,
  RiTerminalLine,
  RiToolsLine,
} from "@remixicon/react";
import { type KeyboardEvent, memo, useState } from "react";
import { Focusable } from "react-aria-components";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { cx as cn } from "@/utils/cx";
import {
  buildToolCallExpandedBody,
  normalizeCompactToolLabel,
  type WorkEntry,
  type WorkEntryIconName,
  toolWorkEntryHeading,
  workEntryIconName,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workEntryIsToolLike,
  workEntryPreview,
} from "./work-entry";

const ENTRY_ICON: Record<WorkEntryIconName, RemixiconComponentType> = {
  bot: RiRobot2Line,
  check: RiCheckLine,
  "circle-alert": RiErrorWarningLine,
  eye: RiEyeLine,
  globe: RiGlobalLine,
  hammer: RiHammerLine,
  "message-circle": RiChat3Line,
  "square-pen": RiEditBoxLine,
  terminal: RiTerminalLine,
  wrench: RiToolsLine,
  x: RiCloseLine,
  zap: RiFlashlightLine,
};

/** Upstream workToneIcon: tone -> icon color class (BoardUI tokens). */
function workToneClass(tone: WorkEntry["tone"]): string {
  return tone === "info" ? "text-text-tertiary" : "text-text-primary";
}

function StatusIndicator({ entry, turnSettled }: { entry: WorkEntry; turnSettled: boolean }) {
  const failed = workEntryIndicatesToolFailure(entry);
  const neutral = workEntryIndicatesToolNeutralStatus(entry);
  const showNeutral = !turnSettled && neutral;
  const showSuccess = workEntryIndicatesToolSuccess(entry) || (turnSettled && neutral);

  if (!failed && !showSuccess && !showNeutral) return null;
  const [Icon, iconClass, label] = failed
    ? ([RiCloseLine, "text-text-error-primary", "Failed"] as const)
    : showSuccess
      ? ([RiCheckLine, "text-lime-600", "Completed"] as const)
      : ([RiSubtractLine, "opacity-70", "Empty"] as const);

  return (
    <TooltipTrigger delay={200}>
      <Focusable>
        <span className="flex size-4 items-center justify-center" aria-label={label}>
          <Icon className={cn("block size-3 shrink-0", iconClass)} aria-hidden />
        </span>
      </Focusable>
      <Tooltip size="sm">{label}</Tooltip>
    </TooltipTrigger>
  );
}

/**
 * The T3 compact work row: `[icon] Heading preview… [chevron] [status]`, expanding
 * in place to a bordered mono body (command + output + changed files). Purely
 * presentational; feed it entries from ./adapter.ts.
 */
export const WorkEntryRow = memo(function WorkEntryRow({
  entry,
  workspaceRoot,
  turnSettled = true,
}: {
  entry: WorkEntry;
  workspaceRoot?: string;
  turnSettled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const entryIconName = workEntryIconName(entry);
  const EntryIcon = ENTRY_ICON[entryIconName];
  const heading = toolWorkEntryHeading(entry);
  const rawPreview = workEntryPreview(entry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const expandedBody = buildToolCallExpandedBody(entry, workspaceRoot);
  const canExpand = expandedBody !== null;
  const showFailedIndicator = workEntryIndicatesToolFailure(entry);
  const showDestructiveRowStyle = showFailedIndicator && !workEntryIsToolLike(entry);
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showDestructiveRowStyle
      ? "text-text-error-primary"
      : entry.tone === "tool" || showFailedIndicator
        ? "text-text-tertiary"
        : workToneClass(entry.tone),
  );
  const headingClass = showDestructiveRowStyle
    ? "font-medium text-text-error-primary"
    : "font-medium text-text-primary";
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": displayText,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        },
      }
    : {};

  return (
    <div
      data-session-ui="work-entry-row"
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-background-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5">
        <span className={iconWrapperClass}>
          <EntryIcon className="block size-3.5 shrink-0 opacity-80" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex w-full min-w-0 items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-text-secondary">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-text-tertiary">
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <RiArrowDownSLine
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              <StatusIndicator entry={entry} turnSettled={turnSettled} />
            </span>
          </div>
        </div>
      </div>
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border-button-default ps-3 pt-0.5"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <pre className="max-h-64 cursor-text select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary">
            {expandedBody}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
