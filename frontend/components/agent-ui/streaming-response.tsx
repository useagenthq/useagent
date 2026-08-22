// Ported from beui.dev registry "streaming-response" (components/agents/streaming-response.tsx +
// agent-disclosure, citations, lib/favicon, lib/ease inlined). Re-expressed with our AlignUI
// tokens + Remixicon. A token-by-token assistant response with a live caret, copy / retry /
// feedback actions, and a collapsible sources footer.
"use client";

import {
  RiArrowDownSLine,
  RiCheckLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiGlobalLine,
  RiRefreshLine,
  RiThumbDownLine,
  RiThumbUpLine,
} from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;
const SPRING_LAYOUT = { type: "spring", stiffness: 360, damping: 32, mass: 0.6 } as const;

/** Resolve a website URL to its conventional root favicon location. */
function getFaviconUrl(value: string) {
  try {
    return new URL("/favicon.ico", value).toString();
  } catch {
    return null;
  }
}

// -- collapsible disclosure ------------------------------------------------
interface AgentDisclosureProps extends Omit<HTMLMotionProps<"div">, "animate" | "initial"> {
  open: boolean;
  openHeight?: CSSProperties["height"];
}

function AgentDisclosure({
  open,
  openHeight = "auto",
  className,
  style,
  transition,
  ...props
}: AgentDisclosureProps) {
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
      transition={transition ?? { duration: reduce ? 0 : open ? 0.22 : 0.14, ease: EASE_OUT }}
      className={cx("overflow-hidden", className)}
      style={{
        ...style,
        height: open ? openHeight : 0,
        pointerEvents: open ? undefined : "none",
        transformOrigin: "top",
      }}
    />
  );
}

// -- citations (only the parts this component uses) ------------------------
export interface CitationItem {
  id: string;
  title: ReactNode;
  domain?: ReactNode;
  url?: string;
}

function citationTargetId(prefix: string, citationId: string) {
  return `${prefix}-${citationId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function CitationFavicon({ url, className }: { url?: string; className?: string }) {
  const favicon = url ? getFaviconUrl(url) : null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  return (
    <span
      aria-hidden="true"
      className={cx("grid size-5 shrink-0 place-items-center text-text-secondary", className)}
    >
      {favicon && failedUrl !== favicon ? (
        <img
          src={favicon}
          alt=""
          width={16}
          height={16}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(favicon)}
          className="size-4 rounded-sm object-contain"
        />
      ) : (
        <RiGlobalLine className="size-3.5" />
      )}
    </span>
  );
}

function CitationStack({
  citations,
  limit = 3,
  className,
}: {
  citations: CitationItem[];
  limit?: number;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cx("flex -space-x-1.5", className)}>
      {citations.slice(0, limit).map((citation) => (
        <CitationFavicon
          key={citation.id}
          url={citation.url}
          className="size-6 rounded-full bg-background-primary-default ring-2 ring-background-primary-default"
        />
      ))}
    </span>
  );
}

function CitationRow({
  citation,
  index,
  idPrefix,
}: {
  citation: CitationItem;
  index: number;
  idPrefix: string;
}) {
  const content = (
    <>
      <CitationFavicon url={citation.url} />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="truncate text-body-2-regular font-medium text-text-secondary transition-colors group-hover/citation:text-text-primary">
          {citation.title}
        </span>
        {citation.domain ? (
          <span className="min-w-0 truncate text-caption-1-regular text-text-tertiary">{citation.domain}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="grid size-5 place-items-center rounded-md bg-background-secondary-default text-[10px] font-semibold tabular-nums text-text-secondary">
          {index}
        </span>
        {citation.url ? (
          <RiExternalLinkLine className="size-3.5 text-text-tertiary transition-colors group-hover/citation:text-text-secondary" />
        ) : null}
      </span>
    </>
  );
  const className =
    "group/citation flex items-center gap-2 rounded-md px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";
  const id = citationTargetId(idPrefix, citation.id);

  return citation.url ? (
    <a id={id} href={citation.url} target="_blank" rel="noreferrer noopener" className={className}>
      {content}
    </a>
  ) : (
    <div id={id} className={className}>
      {content}
    </div>
  );
}

function CitationList({
  citations,
  idPrefix,
  className,
}: {
  citations: CitationItem[];
  idPrefix?: string;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const resolvedPrefix = idPrefix ?? `citation-list-${baseId.replace(/:/g, "")}`;

  return (
    <div className={cx("grid gap-0.5", className)}>
      <AnimatePresence mode="popLayout">
        {citations.map((citation, index) => (
          <motion.div
            layout="position"
            key={citation.id}
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
            transition={
              reduce
                ? { duration: 0 }
                : {
                    opacity: { duration: 0.18, ease: EASE_OUT },
                    y: SPRING_LAYOUT,
                    layout: SPRING_LAYOUT,
                  }
            }
          >
            <CitationRow citation={citation} index={index + 1} idPrefix={resolvedPrefix} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// -- streaming caret -------------------------------------------------------
/** A soft pulsing block the streaming text ends on, hidden once the reply completes. */
function StreamingCaret() {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.span
      aria-hidden="true"
      initial={reduce ? { opacity: 1 } : { opacity: 0.3 }}
      animate={reduce ? { opacity: 1 } : { opacity: [0.3, 1, 0.3] }}
      transition={reduce ? { duration: 0 } : { duration: 1, repeat: Infinity, ease: "easeInOut" }}
      className="ml-0.5 inline-block h-[1em] w-[3px] translate-y-[2px] rounded-full bg-accent-500 align-baseline"
    />
  );
}

export type StreamingResponseStatus = "streaming" | "complete" | "error";
export type StreamingResponseFeedback = "up" | "down" | null;

interface ResponseProps {
  /** Rendered response content. Pass plain text or the output of a Markdown renderer. */
  children: ReactNode;
  status?: StreamingResponseStatus;
  /** Plain-text value copied by the built-in copy action. */
  copyText?: string;
  /** Overrides the built-in clipboard action. */
  onCopy?: () => void | Promise<void>;
  onRetry?: () => void;
  /** Optional sources shown as a compact footer disclosure after streaming. */
  sources?: CitationItem[];
  sourcesOpen?: boolean;
  defaultSourcesOpen?: boolean;
  onSourcesOpenChange?: (open: boolean) => void;
  sourceIdPrefix?: string;
  feedback?: StreamingResponseFeedback;
  defaultFeedback?: StreamingResponseFeedback;
  onFeedbackChange?: (feedback: StreamingResponseFeedback) => void;
  /** Set false when a surrounding conversation log announces streamed text. */
  announce?: boolean;
  /** Hides the built-in completion actions without changing response status. */
  showActions?: boolean;
  className?: string;
  contentClassName?: string;
  actionsClassName?: string;
}

function ResponseAction({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={label === "Helpful" || label === "Not helpful" ? active : undefined}
      onClick={onClick}
      whileTap={reduce ? undefined : { scale: 0.9 }}
      transition={SPRING_PRESS}
      className={cx(
        "grid size-7 place-items-center rounded-md text-text-secondary outline-none transition-colors hover:bg-background-primary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        active && "bg-background-secondary-default text-text-primary",
      )}
    >
      {children}
    </motion.button>
  );
}

/** Token-by-token assistant response. Feed it streamed `children`; while `status` is
 * "streaming" it shows a live caret, and on completion reveals copy / retry / feedback
 * actions and an optional collapsible sources footer. */
export function StreamingResponsePanel({
  children,
  status = "streaming",
  copyText,
  onCopy,
  onRetry,
  sources = [],
  sourcesOpen,
  defaultSourcesOpen = false,
  onSourcesOpenChange,
  sourceIdPrefix,
  feedback,
  defaultFeedback = null,
  onFeedbackChange,
  announce = true,
  showActions = true,
  className,
  contentClassName,
  actionsClassName,
}: ResponseProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const [copied, setCopied] = useState(false);
  const [internalFeedback, setInternalFeedback] = useState<StreamingResponseFeedback>(defaultFeedback);
  const [internalSourcesOpen, setInternalSourcesOpen] = useState(defaultSourcesOpen);
  const copyTimer = useRef<number | undefined>(undefined);
  const currentFeedback = feedback ?? internalFeedback;
  const currentSourcesOpen = sourcesOpen ?? internalSourcesOpen;
  const streaming = status === "streaming";
  const complete = status === "complete";
  const canCopy = Boolean(copyText || onCopy);
  const hasSources = sources.length > 0;
  const shouldShowActions = showActions && !streaming && (canCopy || onRetry || complete || hasSources);
  const sourcesContentId = `${baseId}-sources`;
  const resolvedSourcePrefix = sourceIdPrefix ?? `response-source-${baseId.replace(/:/g, "")}`;

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else if (copyText) await navigator.clipboard?.writeText(copyText);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [copyText, onCopy]);

  const setFeedback = (next: Exclude<StreamingResponseFeedback, null>) => {
    const value = currentFeedback === next ? null : next;
    if (feedback === undefined) setInternalFeedback(value);
    onFeedbackChange?.(value);
  };

  const setSourcesOpen = useCallback(
    (next: boolean) => {
      if (sourcesOpen === undefined) setInternalSourcesOpen(next);
      onSourcesOpenChange?.(next);
    },
    [onSourcesOpenChange, sourcesOpen],
  );

  return (
    <div data-state={status} aria-busy={streaming} className={cx("w-full", className)}>
      <div
        aria-live={announce ? "polite" : "off"}
        className={cx(
          "text-body-2-regular leading-6 text-text-primary [&_a]:font-medium [&_a]:text-accent-500 [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded [&_code]:bg-background-secondary-default [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p+p]:mt-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border-button-default [&_pre]:bg-background-secondary-default [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
          contentClassName,
        )}
      >
        {children}
        {streaming ? <StreamingCaret /> : null}
      </div>

      <AnimatePresence initial={false}>
        {shouldShowActions ? (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.12 : 0.22, ease: EASE_OUT }}
            className="mt-3"
          >
            <div className={cx("flex items-center gap-0.5", actionsClassName)}>
              {canCopy ? (
                <ResponseAction label={copied ? "Copied" : "Copy response"} onClick={handleCopy}>
                  {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
                </ResponseAction>
              ) : null}
              {onRetry ? (
                <ResponseAction label="Retry response" onClick={onRetry}>
                  <RiRefreshLine className="size-3.5" />
                </ResponseAction>
              ) : null}
              {complete ? (
                <>
                  <ResponseAction label="Helpful" active={currentFeedback === "up"} onClick={() => setFeedback("up")}>
                    <RiThumbUpLine className="size-3.5" />
                  </ResponseAction>
                  <ResponseAction
                    label="Not helpful"
                    active={currentFeedback === "down"}
                    onClick={() => setFeedback("down")}
                  >
                    <RiThumbDownLine className="size-3.5" />
                  </ResponseAction>
                </>
              ) : null}
              {hasSources ? (
                <button
                  type="button"
                  aria-expanded={currentSourcesOpen}
                  aria-controls={sourcesContentId}
                  onClick={() => setSourcesOpen(!currentSourcesOpen)}
                  className="group ml-1 inline-flex min-h-7 items-center gap-2 rounded-md px-1.5 text-caption-1-regular text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  <CitationStack citations={sources} />
                  <span className="tabular-nums">
                    {sources.length} {sources.length === 1 ? "source" : "sources"}
                  </span>
                  <motion.span
                    aria-hidden="true"
                    animate={{ rotate: currentSourcesOpen ? 180 : 0 }}
                    transition={reduce ? { duration: 0 } : SPRING_SWAP}
                    className="text-text-tertiary group-hover:text-text-secondary"
                  >
                    <RiArrowDownSLine className="size-3" />
                  </motion.span>
                </button>
              ) : null}
            </div>

            {hasSources ? (
              <AgentDisclosure id={sourcesContentId} open={currentSourcesOpen}>
                <CitationList
                  citations={sources}
                  idPrefix={resolvedSourcePrefix}
                  className="mt-2 rounded-xl bg-background-secondary-default p-2"
                />
              </AgentDisclosure>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// -- self-driving demo -----------------------------------------------------
const SAMPLE_SOURCES: CitationItem[] = [
  { id: "1", title: "State of AI Agents 2026", domain: "a16z.com", url: "https://a16z.com/" },
  { id: "2", title: "Building reliable tool use", domain: "anthropic.com", url: "https://www.anthropic.com/" },
  { id: "3", title: "Streaming UX patterns for agents", domain: "vercel.com", url: "https://vercel.com/" },
];

const FULL_TEXT =
  "Agents get reliable when tool calls are explicit and every step is inspectable. Stream the reasoning, surface the sources, and let the reader interrupt. Two things matter most: grounded citations and a tight feedback loop.";

const TOKENS = FULL_TEXT.match(/\S+\s*/g) ?? [];
const TOKEN_MS = 55;
const HOLD_MS = 2600;

/** Self-driving demo: streams the reply token-by-token, reveals the actions, then loops. */
export function StreamingResponseDemo() {
  const [count, setCount] = useState(0);
  const reduce = useReducedMotion() ?? false;
  const done = count >= TOKENS.length;

  useEffect(() => {
    if (reduce) {
      setCount(TOKENS.length);
      const hold = window.setTimeout(() => setCount(0), HOLD_MS);
      return () => window.clearTimeout(hold);
    }
    if (!done) {
      const t = window.setTimeout(() => setCount((c) => c + 1), TOKEN_MS);
      return () => window.clearTimeout(t);
    }
    const hold = window.setTimeout(() => setCount(0), HOLD_MS);
    return () => window.clearTimeout(hold);
  }, [count, done, reduce]);

  const shown = TOKENS.slice(0, count).join("");

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-sm">
          <StreamingResponsePanel
            status={done ? "complete" : "streaming"}
            copyText={FULL_TEXT}
            onRetry={() => setCount(0)}
            sources={SAMPLE_SOURCES}
            defaultSourcesOpen
          >
            <p>{shown}</p>
          </StreamingResponsePanel>
        </div>
      </div>
    </div>
  );
}

export default StreamingResponseDemo;
