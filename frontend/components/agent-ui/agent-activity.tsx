// Ported from beui.dev registry "agent-activity" (components/agents/agent-activity.tsx +
// agent-disclosure, lib/ease, and the thinking shimmer inlined). Re-expressed with our
// AlignUI tokens + Remixicon. A live agent activity feed: a streaming, collapsible timeline
// of steps, tool calls, web searches and reasoning traces with a working/complete summary.
"use client";

import {
  RiArrowDownSLine,
  RiChat3Line,
  RiCheckboxBlankCircleLine,
  RiCheckLine,
  RiFileTextLine,
  RiGlobalLine,
  RiImageLine,
  RiPencilLine,
  RiSearchLine,
  RiSparkling2Line,
  RiTerminalBoxLine,
  RiToolsLine,
} from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;
const SPRING_LAYOUT = { type: "spring", stiffness: 360, damping: 32, mass: 0.6 } as const;

// -- types -----------------------------------------------------------------
export type AgentActivityStatus = "working" | "complete";
export type AgentStepStatus = "pending" | "active" | "complete";

export interface AgentActivityStep {
  id: string;
  type: "step";
  label: ReactNode;
  status?: AgentStepStatus;
  meta?: ReactNode;
}
export interface AgentActivityText {
  id: string;
  type: "text";
  content: ReactNode;
}
export interface AgentSearchResult {
  id: string;
  title: ReactNode;
  domain?: ReactNode;
  url?: string;
  icon?: ReactNode;
}
export interface AgentActivitySearch {
  id: string;
  type: "search";
  query: ReactNode;
  results?: AgentSearchResult[];
  moreCount?: number;
}
export interface AgentActivityTool {
  id: string;
  type: "tool";
  action: "read" | "edit" | "run" | (string & {});
  target: ReactNode;
  additions?: number;
  deletions?: number;
}
export type AgentTraceKind = "thinking" | "message" | "write" | "run" | "read" | (string & {});
export interface AgentActivityTrace {
  id: string;
  type: "trace";
  kind: AgentTraceKind;
  label: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
}
export type AgentActivityItem =
  | AgentActivityStep
  | AgentActivityText
  | AgentActivitySearch
  | AgentActivityTool
  | AgentActivityTrace;
export type AgentActivityContentType = AgentActivityItem["type"] | "mixed";

// -- collapsible disclosure ------------------------------------------------
function AgentDisclosure({
  open,
  openHeight = "auto",
  children,
  ...props
}: {
  open: boolean;
  openHeight?: CSSProperties["height"];
  children: ReactNode;
  id?: string;
  role?: string;
  "aria-labelledby"?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      {...props}
      aria-hidden={!open}
      inert={!open}
      initial={false}
      animate={
        reduce
          ? { opacity: open ? 1 : 0 }
          : {
              opacity: open ? 1 : 0,
              clipPath: open ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)",
              y: open ? 0 : -4,
            }
      }
      transition={{ duration: reduce ? 0 : open ? 0.22 : 0.14, ease: EASE_OUT }}
      className="overflow-hidden"
      style={{ height: open ? openHeight : 0, pointerEvents: open ? undefined : "none", transformOrigin: "top" }}
    >
      {children}
    </motion.div>
  );
}

// -- thinking shimmer (reuses the global agent-progress-loading-text sweep) --
function ThinkingShimmer({ children = "Thinking..." }: { children?: ReactNode }) {
  return <span className="agent-progress-loading-text inline-block font-medium">{children}</span>;
}

// -- activity rows ---------------------------------------------------------
function StepRow({ item }: { item: AgentActivityStep }) {
  const state = item.status ?? "complete";
  return (
    <div className="flex min-h-7 items-start gap-2.5 rounded-md px-1.5 py-1">
      <span aria-hidden="true" className="mt-0.5 grid size-4 shrink-0 place-items-center text-text-tertiary">
        {state === "complete" ? (
          <RiCheckLine className="size-4" />
        ) : state === "active" ? (
          <span className="relative grid size-3 place-items-center">
            <motion.span
              className="absolute inset-0 rounded-full bg-foreground-icon-primary/10"
              animate={{ opacity: [0.35, 0.8, 0.35] }}
              transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
            />
            <span className="size-1.5 rounded-full bg-foreground-icon-primary/60" />
          </span>
        ) : (
          <RiCheckboxBlankCircleLine className="size-3" />
        )}
      </span>
      <span className={cx("min-w-0 flex-1 leading-5", state === "pending" ? "text-text-tertiary" : "text-text-primary")}>
        {item.label}
      </span>
      {item.meta ? <span className="shrink-0 leading-5 text-text-tertiary">{item.meta}</span> : null}
    </div>
  );
}

function TextRow({ item }: { item: AgentActivityText }) {
  return <div className="rounded-md px-1.5 py-1 leading-5 text-text-secondary">{item.content}</div>;
}

function SearchResultRow({ result }: { result: AgentSearchResult }) {
  const content = (
    <>
      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center text-text-secondary">
        {result.icon ?? <RiGlobalLine className="size-3" />}
      </span>
      <span className="min-w-0 truncate font-medium text-text-primary">{result.title}</span>
      {result.domain ? <span className="min-w-0 truncate text-text-tertiary">{result.domain}</span> : null}
    </>
  );
  const className = cx(
    "flex min-h-7 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors",
    result.url && "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
  );
  return result.url ? (
    <a href={result.url} className={className}>
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

function SearchRow({ item }: { item: AgentActivitySearch }) {
  const reduce = useReducedMotion() ?? false;
  const enter = reduce ? { opacity: 1 } : { opacity: 0, y: 6 };
  const visible = { opacity: 1, y: 0 };
  const exit = reduce ? { opacity: 0 } : { opacity: 0, y: -3 };
  const transition = reduce
    ? { duration: 0 }
    : { opacity: { duration: 0.18, ease: EASE_OUT }, y: SPRING_LAYOUT, layout: SPRING_LAYOUT };
  return (
    <div className="space-y-0.5">
      <div className="flex min-h-7 items-center gap-2.5 rounded-md px-1.5 py-1 text-text-secondary">
        <RiSearchLine aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{item.query}</span>
      </div>
      {item.results?.length ? (
        <div className="space-y-0.5 pl-4">
          <AnimatePresence initial mode="popLayout">
            {item.results.map((result) => (
              <motion.div layout="position" key={result.id} initial={enter} animate={visible} exit={exit} transition={transition}>
                <SearchResultRow result={result} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : null}
      <AnimatePresence initial>
        {item.moreCount ? (
          <motion.div
            key="more-results"
            initial={enter}
            animate={visible}
            exit={exit}
            transition={transition}
            className="px-1.5 py-1 pl-8 text-text-tertiary"
          >
            +{item.moreCount} more
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ActionIcon({ action }: { action: string }) {
  if (action === "read") return <RiFileTextLine className="size-4" />;
  if (action === "edit" || action === "write") return <RiPencilLine className="size-4" />;
  if (action === "run") return <RiTerminalBoxLine className="size-4" />;
  return <RiToolsLine className="size-4" />;
}

function ToolRow({ item }: { item: AgentActivityTool }) {
  const action = item.action.charAt(0).toUpperCase() + item.action.slice(1);
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2.5 rounded-md px-1.5 py-0.5 leading-5">
      <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center text-text-tertiary">
        <ActionIcon action={item.action} />
      </span>
      <span className="shrink-0 font-medium text-text-primary">{action}</span>
      <span className="min-w-0 flex-1 truncate rounded-lg bg-background-secondary-default px-2.5 py-1 font-mono text-caption-1-regular text-text-tertiary">
        {item.target}
      </span>
      {typeof item.additions === "number" || typeof item.deletions === "number" ? (
        <span className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
          {typeof item.additions === "number" ? <span className="text-lime-600">+{item.additions}</span> : null}
          {typeof item.deletions === "number" ? <span className="text-text-error-primary">-{item.deletions}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

function TraceIcon({ kind }: { kind: AgentActivityTrace["kind"] }) {
  if (kind === "thinking") return <RiSparkling2Line className="size-4" />;
  if (kind === "message") return <RiChat3Line className="size-4" />;
  if (kind === "write") return <RiPencilLine className="size-4" />;
  if (kind === "run") return <RiTerminalBoxLine className="size-4" />;
  if (kind === "read") return <RiImageLine className="size-4" />;
  return <RiToolsLine className="size-4" />;
}

function TraceRow({ item }: { item: AgentActivityTrace }) {
  return (
    <div className="grid min-h-8 grid-cols-[1rem_auto_minmax(0,1fr)] items-center gap-2.5 rounded-md px-1.5 py-0.5">
      <span aria-hidden="true" className="grid size-4 place-items-center text-text-tertiary">
        {item.icon ?? <TraceIcon kind={item.kind} />}
      </span>
      <span className="font-medium text-text-primary">{item.label}</span>
      {item.detail ? (
        <span className="min-w-0 truncate rounded-lg bg-background-secondary-default px-2.5 py-1 font-mono text-caption-1-regular text-text-tertiary">
          {item.detail}
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}

function ActivityRow({ item }: { item: AgentActivityItem }) {
  if (item.type === "text") return <TextRow item={item} />;
  if (item.type === "search") return <SearchRow item={item} />;
  if (item.type === "tool") return <ToolRow item={item} />;
  if (item.type === "trace") return <TraceRow item={item} />;
  return <StepRow item={item} />;
}

// -- helpers ---------------------------------------------------------------
function formatSeconds(duration: number) {
  const seconds = Math.max(0, Math.round(duration));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function useControllableOpen({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const controlled = open !== undefined;
  const currentOpen = open ?? internalOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  return [currentOpen, setOpen] as const;
}

function getContentType(items: AgentActivityItem[]): AgentActivityContentType {
  const first = items[0]?.type;
  return first && items.every((item) => item.type === first) ? first : "mixed";
}

function getActiveLabel(type: AgentActivityContentType) {
  if (type === "search") return "Searching the web...";
  if (type === "tool") return "Running tools...";
  if (type === "trace") return "Working through the run...";
  if (type === "mixed") return "Working through it...";
  return "Thinking...";
}

function getSummary(type: AgentActivityContentType, items: AgentActivityItem[], duration: number): ReactNode {
  if (type === "step" || type === "text") {
    return (
      <>
        Thought for <span className="tabular-nums">{formatSeconds(duration)}</span>
      </>
    );
  }
  if (type === "search") return "Searched the web";
  if (type === "tool") return `Ran ${items.length} ${items.length === 1 ? "tool" : "tools"}`;
  if (type === "trace") {
    const messages = items.filter(
      (item) => item.type === "trace" && (item.kind === "thinking" || item.kind === "message"),
    ).length;
    const tools = items.length - messages;
    return `${tools} ${tools === 1 ? "tool call" : "tool calls"}, ${messages} ${messages === 1 ? "message" : "messages"}`;
  }
  return `Completed ${items.length} ${items.length === 1 ? "step" : "steps"}`;
}

// -- AgentActivity primitive -----------------------------------------------
/** Live agent activity feed: a streaming, collapsible timeline of steps, tool calls,
 * searches and reasoning traces. Feed it `items` + a `status`; it shows a shimmering
 * working state and collapses to a summary when complete. */
export function AgentActivityPanel({
  items,
  contentType: initialContentType,
  status = "working",
  duration = 0,
  open,
  defaultOpen = false,
  onOpenChange,
  collapseOnComplete = true,
  activeLabel,
  summary,
  renderWorkingStatus,
  renderCompletedStatus,
  maxHeight = 208,
  className,
  contentClassName,
}: {
  items: AgentActivityItem[];
  contentType?: AgentActivityContentType;
  status?: AgentActivityStatus;
  duration?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  activeLabel?: ReactNode;
  summary?: ReactNode;
  renderWorkingStatus?: (context: { label: ReactNode; duration: number }) => ReactNode;
  renderCompletedStatus?: (context: { summary: ReactNode; duration: number }) => ReactNode;
  maxHeight?: number;
  className?: string;
  contentClassName?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(status);
  const [contentHeight, setContentHeight] = useState(0);
  const [currentOpen, setOpen] = useControllableOpen({ open, defaultOpen, onOpenChange });
  const working = status === "working";
  const expanded = working || currentOpen;
  const contentType = items.length ? getContentType(items) : (initialContentType ?? "mixed");
  const cappedHeight = Math.min(contentHeight, Math.max(0, maxHeight));
  const viewportHeight = working ? Math.max(0, maxHeight) : cappedHeight;
  const capped = contentHeight > maxHeight;
  const streamOffset = working ? Math.min(0, viewportHeight - contentHeight) : 0;

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const measure = () => setContentHeight(node.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (previousStatus.current === "working" && status === "complete") setOpen(!collapseOnComplete);
    previousStatus.current = status;
  }, [collapseOnComplete, setOpen, status]);

  const toggle = () => {
    const next = !currentOpen;
    setOpen(next);
    if (next) requestAnimationFrame(() => viewportRef.current?.scrollTo({ top: 0 }));
  };

  const liveLabel = activeLabel ?? getActiveLabel(contentType);
  const completedSummary = summary ?? getSummary(contentType, items, duration);
  const maskImage = capped
    ? working
      ? "linear-gradient(to bottom, transparent, black 12px)"
      : "linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)"
    : undefined;

  return (
    <div
      data-state={working ? "working" : expanded ? "open" : "closed"}
      data-content={contentType}
      aria-busy={working}
      className={cx("w-full text-body-2-regular", className)}
    >
      {working ? (
        <div id={triggerId} role="status" className="flex h-7 min-w-0 items-center text-text-secondary">
          {renderWorkingStatus ? renderWorkingStatus({ label: liveLabel, duration }) : <ThinkingShimmer>{liveLabel}</ThinkingShimmer>}
        </div>
      ) : (
        <button
          id={triggerId}
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={toggle}
          className="group flex h-7 min-w-0 items-center gap-1.5 rounded-md text-left font-medium text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2"
        >
          <span className="truncate">
            {renderCompletedStatus ? renderCompletedStatus({ summary: completedSummary, duration }) : completedSummary}
          </span>
          <motion.span
            aria-hidden="true"
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="inline-flex shrink-0 text-text-tertiary group-hover:text-text-primary"
          >
            <RiArrowDownSLine className="size-3.5" />
          </motion.span>
        </button>
      )}

      <AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={expanded} openHeight={viewportHeight}>
        <div
          ref={viewportRef}
          className={cx("pr-1 [scrollbar-width:none]", capped && expanded && !working ? "overflow-y-auto" : "overflow-y-hidden")}
          style={{ height: viewportHeight, maskImage, WebkitMaskImage: maskImage }}
        >
          <motion.div
            ref={contentRef}
            role="list"
            initial={false}
            animate={{ y: streamOffset }}
            transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
            className={cx("space-y-0.5 py-2", contentClassName)}
          >
            <AnimatePresence mode="popLayout">
              {items.map((item) => (
                <motion.div
                  layout="position"
                  key={item.id}
                  role="listitem"
                  initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { opacity: { duration: 0.18, ease: EASE_OUT }, y: SPRING_LAYOUT, layout: SPRING_LAYOUT }
                  }
                >
                  <ActivityRow item={item} />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        </div>
      </AgentDisclosure>
    </div>
  );
}

// -- self-contained streaming demo -----------------------------------------
const SCRIPT: AgentActivityItem[] = [
  { id: "a1", type: "tool", action: "read", target: "src/lib/totals.ts" },
  { id: "a2", type: "tool", action: "edit", target: "src/lib/totals.ts", additions: 12, deletions: 4 },
  { id: "a3", type: "tool", action: "run", target: "bun test totals" },
  { id: "a4", type: "tool", action: "edit", target: "src/app/page.tsx", additions: 3, deletions: 1 },
  { id: "a5", type: "tool", action: "run", target: "bun run build" },
];

/** Self-driving demo: streams tool calls one by one, settles to a summary, then loops. */
export function AgentActivityDemo() {
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<AgentActivityStatus>("working");

  useEffect(() => {
    if (count < SCRIPT.length) {
      const t = setTimeout(() => setCount((c) => c + 1), 850);
      return () => clearTimeout(t);
    }
    const done = setTimeout(() => setStatus("complete"), 700);
    return () => clearTimeout(done);
  }, [count]);

  useEffect(() => {
    if (status !== "complete") return;
    const t = setTimeout(() => {
      setStatus("working");
      setCount(0);
    }, 3800);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-3 shadow-sm">
          <AgentActivityPanel items={SCRIPT.slice(0, count)} status={status} collapseOnComplete={false} />
        </div>
      </div>
    </div>
  );
}

export default AgentActivityDemo;
