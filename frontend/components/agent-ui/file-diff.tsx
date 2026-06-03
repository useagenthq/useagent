// Ported from beui.dev registry "file-diff" (components/agents/file-diff.tsx +
// agent-disclosure, lib/ease inlined). Re-expressed with our tokens + Remixicon.
// The shiki syntax highlighter was dropped in favor of a clean mono/token diff view.
// A collapsible added/removed line diff viewer for a single file, with a streaming
// state, change counts, and a copy action.
"use client";

import {
  RiArrowDownSLine,
  RiCheckLine,
  RiFileCodeLine,
  RiFileCopyLine,
  RiLoader4Line,
} from "@remixicon/react";
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
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
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;

export type FileDiffStatus = "streaming" | "complete";
export type FileDiffLineType = "added" | "removed" | "context";

export interface FileDiffLine {
  id: string;
  type?: FileDiffLineType;
  oldLine?: number;
  newLine?: number;
  content: string;
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

// -- change counter --------------------------------------------------------
function ChangeCount({ value, type }: { value: number; type: "added" | "removed" }) {
  if (!value) return null;
  return (
    <span
      className={cx(
        "font-mono text-caption-1-regular tabular-nums",
        type === "added" ? "text-lime-600" : "text-text-error-primary",
      )}
    >
      {type === "added" ? "+" : "-"}
      {value}
    </span>
  );
}

/** Collapsible added/removed line diff viewer for one file. Feed it `lines`; it renders
 * change counts, a streaming state, auto-scrolls while streaming, and can copy the diff. */
export function FileDiffPanel({
  file,
  lines,
  status = "streaming",
  defaultOpen = true,
  collapseOnComplete = true,
  maxHeight = 220,
  copyText,
  onCopy,
  className,
}: {
  file: ReactNode;
  lines: FileDiffLine[];
  status?: FileDiffStatus;
  defaultOpen?: boolean;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  copyText?: string;
  onCopy?: () => void | Promise<void>;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(status);
  const copyTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [currentOpen, setCurrentOpen] = useState(defaultOpen);
  const streaming = status === "streaming";
  const additions = lines.filter((line) => line.type === "added").length;
  const deletions = lines.filter((line) => line.type === "removed").length;
  const canCopy = Boolean(copyText || onCopy);

  const setOpen = useCallback((next: boolean) => setCurrentOpen(next), []);

  useEffect(() => {
    if (previousStatus.current !== "streaming" && status === "streaming") setOpen(true);
    if (previousStatus.current === "streaming" && status === "complete" && collapseOnComplete) {
      setOpen(false);
    }
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
    if (!viewport || !currentOpen || !streaming) return;
    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
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
    <div data-state={status} aria-busy={streaming} className={cx("w-full text-body-2-regular", className)}>
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiFileCodeLine aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate font-mono text-caption-1-regular text-text-secondary">{file}</span>
        <span className="flex shrink-0 items-center gap-2">
          <ChangeCount value={additions} type="added" />
          <ChangeCount value={deletions} type="removed" />
        </span>
        <span className="grid size-4 shrink-0 place-items-center text-text-tertiary">
          {streaming ? (
            <RiLoader4Line aria-label="Applying changes" className={cx("size-3.5", !reduce && "animate-spin")} />
          ) : (
            <RiCheckLine aria-label="Changes applied" className="size-3.5 text-lime-600" />
          )}
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
              data-slot="file-diff-viewport"
              aria-live="polite"
              className="overflow-auto [scrollbar-width:none]"
              style={{ maxHeight }}
            >
              <div className="font-mono text-caption-1-regular leading-5">
                <span className="sr-only">File changes</span>
                {lines.map((line) => {
                  const type = line.type ?? "context";
                  return (
                    <div
                      key={line.id}
                      className={cx(
                        "grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)]",
                        type === "added" && "bg-lime-500/[0.07]",
                        type === "removed" && "bg-red-500/[0.07]",
                      )}
                    >
                      <span className="select-none pr-2 text-right tabular-nums text-text-tertiary">
                        {line.oldLine}
                      </span>
                      <span className="select-none pr-2 text-right tabular-nums text-text-tertiary">
                        {line.newLine}
                      </span>
                      <span
                        className={cx(
                          "select-none text-center text-text-tertiary",
                          type === "added" && "text-lime-600",
                          type === "removed" && "text-text-error-primary",
                        )}
                      >
                        {type === "added" ? "+" : type === "removed" ? "-" : ""}
                      </span>
                      <span
                        className={cx(
                          "min-w-0 whitespace-pre px-1.5 text-text-primary",
                          type === "context" && "text-text-secondary",
                        )}
                      >
                        {line.content}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {canCopy ? (
              <div className="flex justify-end px-2 pb-1.5 pt-1">
                <motion.button
                  type="button"
                  aria-label={copied ? "Copied" : "Copy diff"}
                  title={copied ? "Copied" : "Copy diff"}
                  onClick={handleCopy}
                  whileTap={reduce ? undefined : { scale: 0.9 }}
                  transition={SPRING_PRESS}
                  className="grid size-7 place-items-center rounded-md text-text-secondary outline-none transition-colors hover:bg-background-primary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  {copied ? <RiCheckLine className="size-3.5 text-lime-600" /> : <RiFileCopyLine className="size-3.5" />}
                </motion.button>
              </div>
            ) : null}
          </div>
        </div>
      </AgentDisclosure>
    </div>
  );
}

// -- self-driving streaming demo -------------------------------------------
const DEMO_LINES: FileDiffLine[] = [
  { id: "l1", oldLine: 11, newLine: 11, content: "export function greet(name: string) {" },
  { id: "l2", type: "removed", oldLine: 12, content: '  return "Hello " + name;' },
  { id: "l3", type: "added", newLine: 12, content: "  return `Hello, ${name}!`;" },
  { id: "l4", oldLine: 13, newLine: 13, content: "}" },
  { id: "l5", type: "context", oldLine: 14, newLine: 14, content: "" },
  { id: "l6", type: "added", newLine: 15, content: "export const shout = (s: string) => `${s.toUpperCase()}!`;" },
];

const DEMO_COPY = DEMO_LINES.map((line) => line.content).join("\n");

/** Self-driving demo: streams the diff lines in one at a time, then loops. */
export function FileDiffDemo() {
  const [count, setCount] = useState(1);

  useEffect(() => {
    if (count < DEMO_LINES.length) {
      const t = setTimeout(() => setCount((c) => c + 1), 600);
      return () => clearTimeout(t);
    }
    const reset = setTimeout(() => setCount(1), 3200);
    return () => clearTimeout(reset);
  }, [count]);

  const status: FileDiffStatus = count >= DEMO_LINES.length ? "complete" : "streaming";

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-3 shadow-sm">
          <FileDiffPanel
            file="src/lib/greet.ts"
            lines={DEMO_LINES.slice(0, count)}
            status={status}
            collapseOnComplete={false}
            copyText={DEMO_COPY}
          />
        </div>
      </div>
    </div>
  );
}

export default FileDiffDemo;
