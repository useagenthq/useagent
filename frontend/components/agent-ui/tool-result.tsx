// Ported from beui.dev registry "tool-result" (components/agents/tool-result.tsx +
// agent-disclosure, lib/ease, and the roll-text swap from motion/action-swap inlined).
// Re-expressed with our tokens + Remixicon. The upstream shiki highlighter is
// dropped for a plain monospace terminal viewport (no new deps). A collapsible tool-call
// result card with a morphing status mark, a rolling status label, copy + retry actions,
// and a smooth clip-path reveal.
"use client";

import {
  RiArrowDownSLine,
  RiBracesLine,
  RiCheckboxCircleFill,
  RiCheckLine,
  RiCloseCircleFill,
  RiFileCopyLine,
  RiLoader4Line,
  RiProhibitedLine,
  RiRestartLine,
  RiTerminalBoxLine,
  RiToolsLine,
} from "@remixicon/react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type HTMLMotionProps,
  type Variants,
} from "motion/react";
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
const EASE_OUT_CSS = "cubic-bezier(0.16, 1, 0.3, 1)";
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;

export type ToolResultStatus = "running" | "success" | "error" | "cancelled";
export type ToolResultKind = "terminal" | "request" | "custom";

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

// -- rolling status text ---------------------------------------------------
const ROLL_BLUR = "blur(3px)";
const ROLL_TEXT_VARIANTS: Variants = {
  initial: { opacity: 0, y: "90%", filter: ROLL_BLUR },
  animate: { opacity: 1, y: "0%", filter: "blur(0px)", transition: SPRING_SWAP },
  exit: { opacity: 0, y: "-90%", filter: ROLL_BLUR, transition: { duration: 0.14, ease: EASE_OUT } },
};

function ActionSwapRollText({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();

  useLayoutEffect(() => {
    const nextWidth = measureRef.current?.offsetWidth;
    if (!nextWidth) return;
    setWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
  });

  return (
    <span
      className={cx("relative inline-block overflow-hidden whitespace-nowrap align-bottom", className)}
      style={{ width, transition: reduce ? undefined : `width 220ms ${EASE_OUT_CSS}` }}
    >
      <span ref={measureRef} aria-hidden className="invisible inline-block whitespace-nowrap">
        {children}
      </span>
      <AnimatePresence initial={false}>
        <motion.span
          key={`roll-${value}`}
          variants={ROLL_TEXT_VARIANTS}
          initial={reduce ? false : "initial"}
          animate={reduce ? { opacity: 1, filter: "blur(0px)", y: 0 } : "animate"}
          exit={reduce ? undefined : "exit"}
          className="absolute left-0 top-0 inline-block will-change-[opacity,filter,transform]"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

// -- labels + status marks -------------------------------------------------
function getStatusLabel(status: ToolResultStatus) {
  if (status === "running") return "Running";
  if (status === "success") return "Completed";
  if (status === "error") return "Failed";
  return "Cancelled";
}

function getSwapKey(value: ReactNode, fallback: string) {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function getStatusClass(status: ToolResultStatus) {
  if (status === "running") return "text-accent-500";
  if (status === "success") return "text-lime-600";
  if (status === "error") return "text-text-error-primary";
  return "text-text-tertiary";
}

function KindIcon({ kind }: { kind: ToolResultKind }) {
  if (kind === "terminal") return <RiTerminalBoxLine className="size-4" />;
  if (kind === "request") return <RiBracesLine className="size-4" />;
  return <RiToolsLine className="size-4" />;
}

function StatusIcon({ status, reduce }: { status: ToolResultStatus; reduce: boolean }) {
  if (status === "running") return <RiLoader4Line className={cx("size-3", !reduce && "animate-spin")} />;
  if (status === "success") return <RiCheckboxCircleFill className="size-3" />;
  if (status === "error") return <RiCloseCircleFill className="size-3" />;
  return <RiProhibitedLine className="size-3" />;
}

// -- plain-text terminal output (shiki dropped) ----------------------------
/** Monospace output viewport. Renders the tool's stdout as-is; no syntax highlighter. */
export function ToolResultOutput({ children, className }: { children: string; className?: string }) {
  return (
    <pre
      className={cx(
        "m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-caption-1-regular leading-5 text-text-secondary",
        className,
      )}
    >
      <code>{children}</code>
    </pre>
  );
}

function ToolResultAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      whileTap={reduce ? undefined : { scale: 0.9 }}
      transition={SPRING_PRESS}
      className="grid size-7 place-items-center rounded-md text-text-secondary outline-none transition-colors hover:bg-background-primary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      {children}
    </motion.button>
  );
}

export interface ToolResultProps {
  tool: ReactNode;
  title: ReactNode;
  children: ReactNode;
  status?: ToolResultStatus;
  kind?: ToolResultKind;
  meta?: ReactNode;
  icon?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  copyText?: string;
  onCopy?: () => void | Promise<void>;
  onRetry?: () => void;
  className?: string;
  contentClassName?: string;
}

/** Collapsible tool-call result card. Feed it a title, tool signature, and streamed
 * output; it renders a morphing status mark, a rolling status label, and copy + retry
 * actions. Auto-opens while running and can collapse on completion. */
export function ToolResultPanel({
  tool,
  title,
  children,
  status = "running",
  kind = "custom",
  meta,
  icon,
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 220,
  copyText,
  onCopy,
  onRetry,
  className,
  contentClassName,
}: ToolResultProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(status);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  const running = status === "running";
  const canCopy = Boolean(copyText || onCopy);
  const titleKey = getSwapKey(title, status);
  const metaKey = getSwapKey(meta, `${status}-meta`);
  const toolKey = getSwapKey(tool, `${status}-tool`);
  const statusLabel = getStatusLabel(status);

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (previousStatus.current !== "running" && status === "running") setOpen(true);
    if (previousStatus.current === "running" && status !== "running" && collapseOnComplete) setOpen(false);
    previousStatus.current = status;
  }, [collapseOnComplete, setOpen, status]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !currentOpen || !running) return;

    const frame = requestAnimationFrame(() => {
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduce ? "auto" : "smooth" });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  const handleCopy = useCallback(async () => {
    if (onCopy) await onCopy();
    else if (copyText) await navigator.clipboard?.writeText(copyText);

    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [copyText, onCopy]);

  return (
    <div data-state={status} aria-busy={running} className={cx("w-full text-body-2-regular", className)}>
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background-primary-default"
      >
        <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center text-text-tertiary">
          {icon ?? <KindIcon kind={kind} />}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate font-medium text-text-primary">
            <ActionSwapRollText value={titleKey}>{title}</ActionSwapRollText>
          </span>
          {meta ? (
            <span className="shrink-0 text-caption-1-regular text-text-tertiary">
              <ActionSwapRollText value={metaKey}>{meta}</ActionSwapRollText>
            </span>
          ) : null}
          <span className="min-w-0 truncate font-mono text-[11px] text-text-tertiary">
            <ActionSwapRollText value={toolKey}>{tool}</ActionSwapRollText>
          </span>
        </span>
        <span className={cx("inline-flex shrink-0 items-center gap-1 text-[11px] font-medium", getStatusClass(status))}>
          <StatusIcon status={status} reduce={reduce} />
          <ActionSwapRollText value={status}>{statusLabel}</ActionSwapRollText>
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="shrink-0 text-text-tertiary transition-colors group-hover:text-text-secondary"
        >
          <RiArrowDownSLine className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={currentOpen}>
        <div className="pl-6 pt-1.5">
          <div className="overflow-hidden rounded-xl bg-background-secondary-default">
            <div
              ref={viewportRef}
              role="log"
              aria-live="polite"
              className="overflow-y-auto"
              style={{ maxHeight, scrollbarWidth: "none" }}
            >
              <div className={cx("p-3", contentClassName)}>{children}</div>
            </div>

            {canCopy || onRetry ? (
              <div className="flex items-center gap-0.5 px-2 pb-1.5">
                {canCopy ? (
                  <ToolResultAction label={copied ? "Copied" : "Copy result"} onClick={handleCopy}>
                    {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
                  </ToolResultAction>
                ) : null}
                {onRetry ? (
                  <ToolResultAction label="Run again" onClick={onRetry}>
                    <RiRestartLine className="size-3.5" />
                  </ToolResultAction>
                ) : null}
                <span className="ml-auto text-[11px] text-text-tertiary">
                  <ActionSwapRollText value={status}>{statusLabel}</ActionSwapRollText>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </AgentDisclosure>
    </div>
  );
}

// -- self-contained demo ---------------------------------------------------
const DEMO_OUTPUT = `$ bun add motion @remixicon/react
bun add v1.3.14
 installed motion@12.43.0
 installed @remixicon/react@4.9.0
 3 packages installed [1.20s]
Done.`;

/** Self-driving demo: runs, completes, and retries on a loop. */
export function ToolResultDemo() {
  const [status, setStatus] = useState<ToolResultStatus>("running");

  useEffect(() => {
    if (status === "running") {
      const t = setTimeout(() => setStatus("success"), 1800);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStatus("running"), 2600);
    return () => clearTimeout(t);
  }, [status]);

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-3 shadow-sm">
          <ToolResultPanel
            kind="terminal"
            tool="bun add motion @remixicon/react"
            title="Install packages"
            meta="3 packages"
            status={status}
            collapseOnComplete={false}
            copyText={DEMO_OUTPUT}
            onRetry={() => setStatus("running")}
          >
            <ToolResultOutput>{DEMO_OUTPUT}</ToolResultOutput>
          </ToolResultPanel>
        </div>
      </div>
    </div>
  );
}

export default ToolResultDemo;
