// Ported from beui.dev registry "tool-approval" (components/agents/tool-approval.tsx +
// agent-disclosure, lib/ease inlined). Re-expressed with our AlignUI tokens + Remixicon.
// A human-in-the-loop permission card for reviewing tool details, allowing once,
// remembering access, or denying execution.
"use client";

import {
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiShieldCheckLine,
} from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import { cn } from "@/utils/cn";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;

export type ToolApprovalStatus =
  | "pending"
  | "approving"
  | "approved"
  | "denied"
  | "running"
  | "complete"
  | "error";

export interface ToolApprovalParameter {
  id: string;
  label: ReactNode;
  value: ReactNode;
}

function getStatusCopy(status: ToolApprovalStatus) {
  if (status === "approving") return "Approving";
  if (status === "approved") return "Approved";
  if (status === "denied") return "Denied";
  if (status === "running") return "Running";
  if (status === "complete") return "Completed";
  if (status === "error") return "Failed";
  return "Approval required";
}

// pending=warning, running/approving=information, approved/complete=success, denied/error=error.
function getStatusBadgeClass(status: ToolApprovalStatus) {
  if (status === "pending") return "border-warning-base/30 bg-warning-base/10 text-warning-base";
  if (status === "approving" || status === "running") {
    return "border-information-base/30 bg-information-base/10 text-information-base";
  }
  if (status === "approved" || status === "complete") {
    return "border-success-base/30 bg-success-base/10 text-success-base";
  }
  return "border-error-base/30 bg-error-base/10 text-error-base";
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
      className={cn("overflow-hidden", className)}
      style={{
        ...style,
        height: open ? openHeight : 0,
        pointerEvents: open ? undefined : "none",
        transformOrigin: "top",
      }}
    />
  );
}

/** Human-in-the-loop permission card: review a tool call, allow once / always, or deny. */
export function ToolApprovalCard({
  tool,
  title = "Allow this tool to run?",
  description,
  parameters = [],
  status = "pending",
  defaultOpen = false,
  onApprove,
  onAlwaysAllow,
  onDeny,
  className,
}: {
  tool: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  parameters?: ToolApprovalParameter[];
  status?: ToolApprovalStatus;
  defaultOpen?: boolean;
  onApprove?: () => void;
  onAlwaysAllow?: () => void;
  onDeny?: () => void;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const detailsId = `${baseId}-details`;
  const previousStatus = useRef(status);
  const [currentOpen, setCurrentOpen] = useState(defaultOpen);
  const setOpen = useCallback((next: boolean) => setCurrentOpen(next), []);
  const busy = status === "approving" || status === "running";
  const pending = status === "pending";
  const error = status === "error";

  useEffect(() => {
    if (previousStatus.current === "pending" && status !== "pending") setOpen(false);
    previousStatus.current = status;
  }, [setOpen, status]);

  return (
    <div
      data-state={status}
      aria-busy={busy}
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 text-paragraph-sm shadow-regular-sm",
        className,
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-bg-weak-50 text-text-sub-600",
            error && "text-error-base",
          )}
        >
          {busy ? (
            <RiLoader4Line className={cn("size-4", !reduce && "animate-spin")} />
          ) : error ? (
            <RiErrorWarningLine className="size-4" />
          ) : status === "denied" ? (
            <RiCloseLine className="size-4" />
          ) : status === "approved" || status === "complete" ? (
            <RiCheckLine className="size-4" />
          ) : (
            <RiShieldCheckLine className="size-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-label-sm text-text-strong-950">{title}</div>
              <div className="mt-0.5 truncate font-mono text-paragraph-xs text-text-sub-600">{tool}</div>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                getStatusBadgeClass(status),
              )}
            >
              {getStatusCopy(status)}
            </span>
          </div>
          {description ? <p className="mt-2 leading-5 text-text-sub-600">{description}</p> : null}

          {parameters.length ? (
            <button
              type="button"
              aria-expanded={currentOpen}
              aria-controls={detailsId}
              onClick={() => setOpen(!currentOpen)}
              className="mt-2 inline-flex items-center gap-1 rounded-md text-paragraph-xs font-medium text-text-sub-600 outline-none transition-colors hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
            >
              View details
              <motion.span
                aria-hidden="true"
                animate={{ rotate: currentOpen ? 180 : 0 }}
                transition={reduce ? { duration: 0 } : SPRING_SWAP}
              >
                <RiArrowDownSLine className="size-3.5" />
              </motion.span>
            </button>
          ) : null}
        </div>
      </div>

      <AgentDisclosure id={detailsId} open={currentOpen}>
        <dl className="mx-4 mb-4 grid gap-2 rounded-xl bg-bg-weak-50 p-3">
          {parameters.map((parameter) => (
            <div
              key={parameter.id}
              className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3 text-paragraph-xs"
            >
              <dt className="text-text-sub-600">{parameter.label}</dt>
              <dd className="min-w-0 break-words font-mono text-text-strong-950">{parameter.value}</dd>
            </div>
          ))}
        </dl>
      </AgentDisclosure>

      <AnimatePresence initial={false}>
        {pending ? (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.12 : 0.22, ease: EASE_OUT }}
            className="flex flex-wrap items-center gap-2 border-t border-stroke-soft-200 px-4 py-3"
          >
            <motion.button
              type="button"
              onClick={onApprove}
              whileTap={reduce ? undefined : { scale: 0.97 }}
              transition={SPRING_PRESS}
              className="rounded-xl bg-primary-base px-3 py-1.5 text-paragraph-xs font-medium text-static-white outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2"
            >
              Allow once
            </motion.button>
            {onAlwaysAllow ? (
              <motion.button
                type="button"
                onClick={onAlwaysAllow}
                whileTap={reduce ? undefined : { scale: 0.97 }}
                transition={SPRING_PRESS}
                className="rounded-xl border border-stroke-soft-200 bg-bg-white-0 px-3 py-1.5 text-paragraph-xs font-medium text-text-strong-950 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
              >
                Always allow
              </motion.button>
            ) : null}
            <button
              type="button"
              onClick={onDeny}
              className="rounded-xl px-3 py-1.5 text-paragraph-xs font-medium text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
            >
              Deny
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const DEMO_PARAMS: ToolApprovalParameter[] = [
  { id: "command", label: "Command", value: "rm -rf ./dist && bun run build" },
  { id: "cwd", label: "Working dir", value: "~/apps/agent-ui" },
  { id: "timeout", label: "Timeout", value: "120s" },
];

/** Self-driving demo: approve -> approving -> running -> complete, then resets; deny -> denied. */
export function ToolApprovalDemo() {
  const [status, setStatus] = useState<ToolApprovalStatus>("pending");

  useEffect(() => {
    if (status === "approving") {
      const t = setTimeout(() => setStatus("running"), 700);
      return () => clearTimeout(t);
    }
    if (status === "running") {
      const t = setTimeout(() => setStatus("complete"), 1500);
      return () => clearTimeout(t);
    }
    if (status === "complete" || status === "denied") {
      const t = setTimeout(() => setStatus("pending"), 2600);
      return () => clearTimeout(t);
    }
  }, [status]);

  return (
    <div className="flex items-center justify-center rounded-xl bg-bg-weak-50 p-3">
      <div className="w-full max-w-md">
        <ToolApprovalCard
          tool="shell.exec"
          description="The agent wants to run a shell command in your project. Review the parameters before allowing."
          parameters={DEMO_PARAMS}
          status={status}
          defaultOpen
          onApprove={() => setStatus("approving")}
          onAlwaysAllow={() => setStatus("approving")}
          onDeny={() => setStatus("denied")}
        />
      </div>
    </div>
  );
}

export default ToolApprovalDemo;
