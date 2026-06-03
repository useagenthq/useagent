// Ported from beui.dev registry "todo-list" (components/agents/todo-list.tsx +
// agent-disclosure, lib/ease, and the roll-text swap from motion/action-swap inlined).
// Re-expressed with our tokens + Remixicon. A collapsible agent task plan with
// morphing status marks, a rolling completion count, and smooth list updates.
"use client";

import { RiArrowDownSLine, RiListCheck2 } from "@remixicon/react";
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
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;
const SPRING_LAYOUT = { type: "spring", stiffness: 360, damping: 32, mass: 0.6 } as const;

export type TodoItemStatus = "pending" | "in-progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  title: ReactNode;
  status?: TodoItemStatus;
  progress?: number;
  detail?: ReactNode;
}

function statusLabel(status: TodoItemStatus) {
  if (status === "in-progress") return "In progress";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
  return "Pending";
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

// -- rolling completion count ----------------------------------------------
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

// -- status marks ----------------------------------------------------------
function TodoHeaderIcon({ complete }: { complete: boolean }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <span aria-hidden="true" className="relative grid size-6 shrink-0 place-items-center">
      <AnimatePresence initial={false} mode="popLayout">
        {complete ? (
          <motion.svg
            key="complete"
            viewBox="0 0 24 24"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.72 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="absolute size-[22px] overflow-visible text-lime-600"
          >
            <circle cx="12" cy="12" r="9" fill="currentColor" />
            <motion.path
              d="M7.5 12.25 10.5 15.25 16.75 8.75"
              fill="none"
              stroke="white"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }}
            />
          </motion.svg>
        ) : (
          <motion.span
            key="todo"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.72 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="absolute grid place-items-center text-text-secondary"
          >
            <RiListCheck2 className="size-4" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function TodoStatusIcon({ status, progress }: { status: TodoItemStatus; progress?: number }) {
  const reduce = useReducedMotion() ?? false;
  const normalizedProgress = progress === undefined ? 0.68 : Math.min(100, Math.max(0, progress)) / 100;

  return (
    <motion.svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      initial={false}
      className={cx(
        "mx-0.5 size-5 shrink-0 overflow-visible text-text-secondary",
        status === "in-progress" && "text-text-primary",
        status === "cancelled" && "text-text-error-primary",
      )}
    >
      <motion.circle
        cx="12"
        cy="12"
        r="9"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={status === "pending" ? "2 3" : undefined}
        strokeLinecap="round"
        initial={false}
        animate={{ fillOpacity: status === "completed" ? 0.06 : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }}
        className={cx(status === "in-progress" && "opacity-20")}
      />
      <motion.circle
        cx="12"
        cy="12"
        r="9"
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        initial={false}
        animate={{
          pathLength: status === "in-progress" ? normalizedProgress : 0,
          opacity: status === "in-progress" ? 1 : 0,
          rotate: status === "in-progress" && progress === undefined && !reduce ? 360 : -90,
        }}
        transition={
          status === "in-progress" && progress === undefined && !reduce
            ? { rotate: { duration: 1.1, repeat: Infinity, ease: "linear" } }
            : reduce
              ? { duration: 0 }
              : SPRING_LAYOUT
        }
        style={{ transformOrigin: "12px 12px" }}
      />
      <motion.path
        d="M7.5 12.25 10.5 15.25 16.75 8.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        animate={{ pathLength: status === "completed" ? 1 : 0, opacity: status === "completed" ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }}
      />
      <motion.path
        d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        initial={false}
        animate={{ pathLength: status === "cancelled" ? 1 : 0, opacity: status === "cancelled" ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }}
      />
    </motion.svg>
  );
}

/** Collapsible agent task plan. Feed it `items`; it renders status marks, a rolling
 * completion count, and animates list changes. */
export function TodoListPanel({
  items,
  title = "To-dos",
  defaultOpen = true,
  collapseOnComplete = true,
  maxHeight = 248,
  className,
}: {
  items: TodoItem[];
  title?: ReactNode;
  defaultOpen?: boolean;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousComplete = useRef(false);
  const [currentOpen, setCurrentOpen] = useState(defaultOpen);
  const completed = items.filter((item) => item.status === "completed").length;
  const allComplete = items.length > 0 && completed === items.length;
  const itemCount = items.length;

  const setOpen = useCallback((next: boolean) => setCurrentOpen(next), []);

  useEffect(() => {
    if (previousComplete.current && !allComplete) setOpen(true);
    if (!previousComplete.current && allComplete && collapseOnComplete) setOpen(false);
    previousComplete.current = allComplete;
  }, [allComplete, collapseOnComplete, setOpen]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || itemCount === 0) return;
    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduce ? "auto" : "smooth" });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [itemCount, reduce]);

  return (
    <section
      aria-label="Agent task list"
      className={cx(
        "w-full overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-sm",
        className,
      )}
    >
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <TodoHeaderIcon complete={allComplete} />
        <h3 className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary">{title}</h3>
        <span
          className={cx(
            "shrink-0 text-caption-1-medium font-medium tabular-nums text-text-secondary",
            allComplete && "text-lime-600",
          )}
        >
          <span className="sr-only">
            {completed} of {items.length} tasks completed
          </span>
          <span aria-hidden="true" className="inline-flex">
            <ActionSwapRollText value={String(completed)}>{completed}</ActionSwapRollText>
            <span>/</span>
            <span>{items.length}</span>
          </span>
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="text-text-tertiary transition-colors group-hover:text-text-secondary"
        >
          <RiArrowDownSLine className="size-4" />
        </motion.span>
      </button>

      <AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={currentOpen}>
        <div ref={viewportRef} className="overflow-y-auto px-2 pb-2" style={{ maxHeight, scrollbarWidth: "none" }}>
          {items.length ? (
            <ol aria-live="polite" className="space-y-0">
              <AnimatePresence initial={false} mode="popLayout">
                {items.map((item) => {
                  const status = item.status ?? "pending";
                  return (
                    <motion.li
                      layout="position"
                      key={item.id}
                      initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                      transition={
                        reduce
                          ? { duration: 0 }
                          : { opacity: { duration: 0.18, ease: EASE_OUT }, y: SPRING_LAYOUT, layout: SPRING_LAYOUT }
                      }
                      className="flex min-h-9 items-center gap-2.5 rounded-xl px-1.5 py-1"
                    >
                      <TodoStatusIcon status={status} progress={item.progress} />
                      <span className="sr-only">{statusLabel(status)}: </span>
                      <span
                        className={cx(
                          "min-w-0 flex-1 truncate text-body-2-regular leading-5",
                          status === "pending" && "text-text-tertiary",
                          status === "in-progress" && "text-text-primary",
                          status === "completed" && "text-text-tertiary",
                          status === "cancelled" && "text-text-tertiary",
                        )}
                      >
                        <span className="relative inline-block max-w-full">
                          {item.title}
                          <motion.span
                            aria-hidden="true"
                            initial={false}
                            animate={{ scaleX: status === "completed" ? 1 : 0, opacity: status === "completed" ? 1 : 0 }}
                            transition={reduce ? { duration: 0 } : { duration: 0.28, ease: EASE_OUT, delay: 0.06 }}
                            className="absolute inset-x-0 top-1/2 h-px origin-left bg-current"
                          />
                        </span>
                      </span>
                      {item.detail ? (
                        <span className="shrink-0 text-body-2-regular text-text-tertiary">{item.detail}</span>
                      ) : null}
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ol>
          ) : (
            <p className="px-1.5 py-2 text-body-2-regular text-text-secondary">No tasks yet</p>
          )}
        </div>
      </AgentDisclosure>
    </section>
  );
}

const BASE_TASKS: { id: string; title: string; detail?: string }[] = [
  { id: "scan", title: "Scan the repository for dead code" },
  { id: "plan", title: "Draft a refactor plan", detail: "3 files" },
  { id: "tests", title: "Write tests for the parser" },
  { id: "migrate", title: "Migrate tokens to the shared layer" },
  { id: "pr", title: "Open a pull request for review" },
];

const STEP_MS = 1500;

/** Self-driving demo: walks the plan from pending to complete, then loops. */
export function TodoListDemo() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % (BASE_TASKS.length + 1)), STEP_MS);
    return () => clearInterval(id);
  }, []);

  const items: TodoItem[] = BASE_TASKS.map((task, i) => ({
    id: task.id,
    title: task.title,
    detail: task.detail,
    status: i < step ? "completed" : i === step ? "in-progress" : "pending",
  }));

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <TodoListPanel items={items} title="Refactor plan" collapseOnComplete={false} defaultOpen />
      </div>
    </div>
  );
}

export default TodoListDemo;
