// Ported from beui.dev registry "message-bubble" (components/agents/message-bubble.tsx +
// message-context, lib/ease inlined). Re-expressed with our AlignUI tokens + Remixicon.
// A chat message row: avatar, an aligned bubble with a soft pop-in surface, a collapsible
// clamp for long turns, and hover-revealed row actions (copy / regenerate).
"use client";

import {
  RiArrowDownSLine,
  RiCheckLine,
  RiFileCopyLine,
  RiRefreshLine,
  RiSparkling2Line,
  RiThumbDownLine,
  RiThumbUpLine,
  RiUserLine,
} from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";

import { cn } from "@/utils/cn";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;
const SPRING_LAYOUT = { type: "spring", stiffness: 360, damping: 32, mass: 0.6 } as const;
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;
// Sent bubbles pop into place quickly with one restrained overshoot.
const BUBBLE_POP = { type: "spring", stiffness: 520, damping: 27, mass: 0.52 } as const;
const BUBBLE_CONTENT_REVEAL = { duration: 0.12, ease: EASE_OUT, delay: 0.04 } as const;

export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: ReactNode;
}

// -- collapsible clamp for long turns --------------------------------------
const LINE_CLAMP_CLASS = {
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
} as const;

/** Clamp a long message to N lines with a soft fade, toggled by a Show more / Show less pill. */
export function MessageBubbleCollapsible({
  children,
  collapsedLines = 4,
  moreLabel = "Show more",
  lessLabel = "Show less",
  className,
}: {
  children: ReactNode;
  collapsedLines?: 2 | 3 | 4 | 5 | 6;
  moreLabel?: ReactNode;
  lessLabel?: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const contentId = useId();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  return (
    <div className={cn("w-full", className)}>
      <div
        id={contentId}
        className={cn(
          "transition-[mask-image] duration-200",
          !open && LINE_CLAMP_CLASS[collapsedLines],
          !open && "[mask-image:linear-gradient(to_bottom,#000_68%,transparent_100%)]",
        )}
      >
        {children}
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
        className="mt-2 inline-flex h-7 items-center gap-1 rounded-full px-2 text-paragraph-xs font-medium text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
      >
        <span>{open ? lessLabel : moreLabel}</span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
        >
          <RiArrowDownSLine className="size-3.5" />
        </motion.span>
      </button>
    </div>
  );
}

// -- avatar ----------------------------------------------------------------
function MessageAvatar({ role }: { role: MessageRole }) {
  const isUser = role === "user";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full",
        isUser ? "bg-bg-weak-50 text-text-sub-600" : "bg-primary-base text-static-white",
      )}
    >
      {isUser ? <RiUserLine className="size-4" /> : <RiSparkling2Line className="size-4" />}
    </span>
  );
}

// -- row action ------------------------------------------------------------
function MessageAction({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      whileTap={reduce ? undefined : { scale: 0.9 }}
      transition={SPRING_PRESS}
      className={cn(
        "grid size-7 place-items-center rounded-lg text-text-soft-400 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-sub-600 focus-visible:ring-2 focus-visible:ring-stroke-strong-950",
        active && "text-primary-base",
      )}
    >
      {children}
    </motion.button>
  );
}

function bubbleSurfaceClass(role: MessageRole) {
  return cn(
    "pointer-events-none absolute inset-0 -z-10 rounded-2xl",
    role === "user"
      ? "origin-bottom-right bg-primary-base"
      : "origin-bottom-left bg-bg-weak-50",
  );
}

/** A single chat turn: avatar + aligned bubble with a pop-in surface and hover row actions. */
export function MessageBubble({
  role,
  children,
  animateIn = false,
  onCopy,
  onRegenerate,
  showActions = true,
  className,
}: {
  role: MessageRole;
  children: ReactNode;
  animateIn?: boolean;
  onCopy?: () => void;
  onRegenerate?: () => void;
  showActions?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const isUser = role === "user";
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    setCopied(true);
    onCopy?.();
  }, [onCopy]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <motion.div
      layout={reduce ? false : "position"}
      data-role={role}
      initial={animateIn ? (reduce ? { opacity: 0 } : { opacity: 0, y: 6 }) : false}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.99 }}
      transition={reduce ? { duration: 0.12 } : SPRING_LAYOUT}
      className={cn(
        "group/message flex w-full items-start gap-2.5",
        isUser && "flex-row-reverse",
        className,
      )}
    >
      <MessageAvatar role={role} />

      <div className={cn("flex min-w-0 flex-col gap-1", isUser ? "items-end" : "items-start")}>
        <div
          data-slot="message-bubble-content"
          className={cn(
            "relative z-0 min-w-9 max-w-[80%] rounded-2xl px-3.5 py-2.5 text-paragraph-sm leading-6",
            isUser ? "text-static-white" : "text-text-strong-950",
            "[&_code]:rounded [&_code]:bg-bg-weak-50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_p+p]:mt-2",
          )}
        >
          <motion.span
            aria-hidden="true"
            initial={animateIn && !reduce ? { opacity: 0, scale: 0.92 } : false}
            animate={{ opacity: 1, scale: 1 }}
            transition={
              reduce
                ? { duration: 0 }
                : { opacity: { duration: 0.12, ease: EASE_OUT }, scale: BUBBLE_POP }
            }
            className={bubbleSurfaceClass(role)}
          />
          <motion.div
            initial={animateIn ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={reduce ? { duration: 0.12, ease: EASE_OUT } : BUBBLE_CONTENT_REVEAL}
            className="relative"
          >
            {children}
          </motion.div>
        </div>

        {showActions ? (
          <div
            className={cn(
              "flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 focus-within:opacity-100",
              isUser && "flex-row-reverse",
            )}
          >
            <MessageAction label={copied ? "Copied" : "Copy"} onClick={handleCopy} active={copied}>
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={copied ? "check" : "copy"}
                  initial={reduce ? false : { opacity: 0, scale: 0.72 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.72 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                  className="grid place-items-center"
                >
                  {copied ? (
                    <RiCheckLine className="size-4 text-success-base" />
                  ) : (
                    <RiFileCopyLine className="size-4" />
                  )}
                </motion.span>
              </AnimatePresence>
            </MessageAction>
            {!isUser ? (
              <>
                <MessageAction label="Regenerate" onClick={onRegenerate}>
                  <RiRefreshLine className="size-4" />
                </MessageAction>
                <MessageAction label="Good response">
                  <RiThumbUpLine className="size-4" />
                </MessageAction>
                <MessageAction label="Bad response">
                  <RiThumbDownLine className="size-4" />
                </MessageAction>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

// -- self-driving demo -----------------------------------------------------
const LONG =
  "Here's the read on the Q3 deck. Revenue landed at $4.2M, up 23% QoQ, with expansion carrying most of the lift while new-logo velocity stayed flat. Gross margin improved 4 points to 71% as the infra migration finished ahead of plan. Two things to flag: net retention slipped to 108% on a handful of mid-market downgrades, and the cash runway slide assumes the Series B closes in November - if that slips a quarter, the model dips below the 12-month buffer the board asked us to hold.";

const SCRIPT: ChatMessage[] = [
  { id: "u1", role: "user", content: "Can you summarize the Q3 board deck and flag anything risky?" },
  { id: "a1", role: "assistant", content: "On it - reading the deck now." },
  {
    id: "a2",
    role: "assistant",
    content: <MessageBubbleCollapsible collapsedLines={3}>{LONG}</MessageBubbleCollapsible>,
  },
  { id: "u2", role: "user", content: "Thanks - can you send that to the board channel?" },
];

const STEP_MS = 1600;

/** Self-driving demo: a short chat that streams in message by message, then loops. */
export function MessageBubbleDemo() {
  const [count, setCount] = useState(1);

  useEffect(() => {
    const id = setInterval(() => setCount((c) => (c % SCRIPT.length) + 1), STEP_MS);
    return () => clearInterval(id);
  }, []);

  const visible = SCRIPT.slice(0, count);

  return (
    <div className="flex items-center justify-center rounded-xl bg-bg-weak-50 p-3">
      <div className="w-full max-w-md rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-4 shadow-regular-sm">
        <div className="flex flex-col gap-4">
          <AnimatePresence initial={false} mode="popLayout">
            {visible.map((message) => (
              <MessageBubble key={message.id} role={message.role} animateIn>
                {message.content}
              </MessageBubble>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export default MessageBubbleDemo;
