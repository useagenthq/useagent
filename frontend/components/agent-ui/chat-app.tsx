// Ported from beui.dev registry "chat-app" (components/agents/chat-app.tsx +
// motion/animated-sidebar, motion/shared-layout-bg, lib/ease inlined). Re-expressed with
// our AlignUI tokens + Remixicon. A compact end-to-end chat composition: a collapsible
// conversation rail with a morphing active pill, an animated message thread, and a composer.
// The heavy registry shell (offcanvas portal, mobile media-query, focus-trap, sidebar
// context system) is dropped in favor of a single self-contained, self-driving demo.
"use client";

import {
  RiAddLine,
  RiArrowUpLine,
  RiChat3Line,
  RiEditBoxLine,
  RiLayoutLeftLine,
  RiSparkling2Line,
} from "@remixicon/react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "@/utils/cn";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_LAYOUT = { type: "spring", stiffness: 360, damping: 32, mass: 0.6 } as const;
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;
const SPRING_MORPH = { type: "spring", stiffness: 380, damping: 35, mass: 0.75 } as const;
const LABEL_ENTER = { duration: 0.2, delay: 0.08, ease: EASE_OUT } as const;
const LABEL_EXIT = { duration: 0.12, ease: EASE_OUT } as const;

const messageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
};

export type ChatMessage = { role: "user" | "assistant"; content: string };
export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
}

// -- conversation rail -----------------------------------------------------
/** A single rail row: hover pill + a morphing active background shared across the list. */
function RailButton({
  icon,
  children,
  badge,
  collapsed,
  isActive = false,
  activeLayoutId,
  onSelect,
}: {
  icon: ReactNode;
  children: ReactNode;
  badge?: ReactNode;
  collapsed: boolean;
  isActive?: boolean;
  activeLayoutId?: string;
  onSelect?: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const label = typeof children === "string" ? children : undefined;

  return (
    <motion.button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      whileTap={reduce ? undefined : { scale: 0.98 }}
      transition={SPRING_PRESS}
      className={cn(
        "relative flex min-h-9 w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-xl px-3 text-left text-label-sm outline-none",
        "text-text-sub-600 transition-colors hover:text-text-strong-950",
        "focus-visible:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950",
        isActive && "text-text-strong-950",
      )}
    >
      {isActive && activeLayoutId ? (
        <motion.span
          layoutId={activeLayoutId}
          transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
          className="absolute inset-0 rounded-xl bg-bg-weak-50"
        />
      ) : null}
      <span aria-hidden="true" className="relative z-10 grid size-5 shrink-0 place-items-center">
        {icon}
      </span>
      <motion.span
        initial={false}
        animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -4 : 0 }}
        transition={reduce ? { duration: 0 } : collapsed ? LABEL_EXIT : LABEL_ENTER}
        aria-hidden={collapsed}
        className={cn("relative z-10 min-w-0 flex-1 truncate", collapsed && "pointer-events-none")}
      >
        {children}
      </motion.span>
      {badge && !collapsed ? (
        <span className="relative z-10 shrink-0 text-paragraph-xs text-text-soft-400">{badge}</span>
      ) : null}
    </motion.button>
  );
}

/** Compact chat composition: conversation rail, animated thread, and composer. */
export function ChatApp({
  conversations,
  className,
}: {
  conversations: ChatConversation[];
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const uid = useId();
  const activeLayoutId = `${uid}-rail-active`;
  const [collapsed, setCollapsed] = useState(false);
  const [activeId, setActiveId] = useState(conversations[0]?.id);
  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];

  useEffect(() => {
    const viewport = threadRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [activeId, reduce]);

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDraft("");
  };

  return (
    <div
      className={cn(
        "flex h-[440px] w-full overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm",
        className,
      )}
    >
      {/* rail */}
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 60 : 208 }}
        transition={reduce ? { duration: 0 } : SPRING_MORPH}
        className="flex shrink-0 flex-col overflow-hidden border-r border-stroke-soft-200 bg-bg-weak-50"
        aria-label="Conversations"
      >
        <div className="flex shrink-0 flex-col gap-2 p-3">
          <div className="flex min-w-0 items-center gap-2 px-1">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary-base text-static-white">
              <RiSparkling2Line className="size-4" />
            </span>
            <motion.span
              initial={false}
              animate={{ opacity: collapsed ? 0 : 1 }}
              transition={reduce ? { duration: 0 } : collapsed ? LABEL_EXIT : LABEL_ENTER}
              className="min-w-0 flex-1 truncate text-label-sm font-semibold text-text-strong-950"
            >
              Agent UI
            </motion.span>
          </div>
          <RailButton icon={<RiEditBoxLine className="size-4" />} collapsed={collapsed}>
            New chat
          </RailButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-2 py-1">
          <div
            aria-hidden={collapsed}
            className={cn(
              "mb-1 h-5 overflow-hidden px-2 text-[10px] font-medium uppercase tracking-[0.14em] text-text-soft-400 transition-opacity",
              collapsed ? "opacity-0" : "opacity-100",
            )}
          >
            Recent
          </div>
          <div className="flex flex-col gap-0.5">
            {conversations.map((c) => (
              <RailButton
                key={c.id}
                icon={<RiChat3Line className="size-4" />}
                collapsed={collapsed}
                isActive={c.id === active?.id}
                activeLayoutId={activeLayoutId}
                onSelect={() => setActiveId(c.id)}
              >
                {c.title}
              </RailButton>
            ))}
          </div>
        </div>

        <div className="shrink-0 border-t border-stroke-soft-200 p-3">
          <RailButton
            icon={
              <span className="grid size-5 place-items-center rounded-full bg-bg-white-0 text-[9px] font-semibold text-text-sub-600">
                PR
              </span>
            }
            badge="Pro"
            collapsed={collapsed}
          >
            Priya Rao
          </RailButton>
        </div>
      </motion.aside>

      {/* main pane */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg-white-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-stroke-soft-200 px-3">
          <button
            type="button"
            aria-label="Toggle sidebar"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
          >
            <RiLayoutLeftLine className="size-[18px]" />
          </button>
          <span className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">
            {active?.title}
          </span>
          <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-bg-weak-50 px-2 py-1 text-[11px] font-medium text-text-sub-600 sm:inline-flex">
            <RiSparkling2Line className="size-3" />
            Opus 4.8
          </span>
        </header>

        <div ref={threadRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <AnimatePresence mode="popLayout" initial={false}>
            {active?.messages.map((message, index) => (
              <motion.div
                layout="position"
                key={`${active.id}-${index}`}
                variants={reduce ? undefined : messageVariants}
                initial={reduce ? { opacity: 1 } : "initial"}
                animate={reduce ? { opacity: 1 } : "animate"}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { opacity: { duration: 0.2, ease: EASE_OUT, delay: index * 0.04 }, y: SPRING_LAYOUT, layout: SPRING_LAYOUT }
                }
                className={cn(
                  "max-w-[80%] rounded-2xl px-3.5 py-2 text-paragraph-sm leading-relaxed",
                  message.role === "user"
                    ? "self-end rounded-br-md bg-primary-base text-static-white"
                    : "self-start rounded-tl-md bg-bg-weak-50 text-text-strong-950",
                )}
              >
                {message.content}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="shrink-0 p-3">
          <form
            onSubmit={send}
            className="flex items-end gap-2 rounded-2xl bg-bg-weak-50 p-2 focus-within:ring-2 focus-within:ring-stroke-strong-950"
          >
            <button
              type="button"
              aria-label="Add attachment"
              className="grid size-8 shrink-0 place-items-center rounded-xl text-text-sub-600 outline-none transition-colors hover:bg-bg-white-0 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
            >
              <RiAddLine className="size-4" />
            </button>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={1}
              aria-label="Message"
              placeholder={`Message ${active?.title ?? "the agent"}`}
              className="min-h-6 flex-1 resize-none bg-transparent px-1 py-1.5 text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
            />
            <motion.button
              type="submit"
              aria-label="Send"
              disabled={!draft.trim()}
              whileTap={reduce || !draft.trim() ? undefined : { scale: 0.94 }}
              transition={SPRING_PRESS}
              className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary-base text-static-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 disabled:opacity-40"
            >
              <RiArrowUpLine className="size-4" />
            </motion.button>
          </form>
        </div>
      </div>
    </div>
  );
}

const DEMO_CONVERSATIONS: ChatConversation[] = [
  {
    id: "refactor",
    title: "Refactor the token layer",
    messages: [
      { role: "user", content: "Can you sweep the app surfaces for hard-coded colors and move them to tokens?" },
      { role: "assistant", content: "On it. I'll map near-black text to the ink tokens, neutralize the rainbow avatars, and swap card hairlines for soft shadows, one surgical pass per folder." },
      { role: "user", content: "Keep status colors where they're real status." },
      { role: "assistant", content: "Understood. Positive, warning, and negative deltas keep their semantic tokens; only arbitrary category color gets neutralized." },
    ],
  },
  {
    id: "evals",
    title: "Draft retrieval evals",
    messages: [
      { role: "user", content: "Write a first eval set for the retrieval agent." },
      { role: "assistant", content: "Here's a starter suite covering exact-match, paraphrase, and adversarial-distractor cases. Want me to wire it into CI?" },
    ],
  },
  {
    id: "release",
    title: "Release notes 5.2",
    messages: [
      { role: "user", content: "Summarize what shipped this week for the changelog." },
      { role: "assistant", content: "Six components ported from the registry, a full token-drift sweep across the app surfaces, and the new agent sidebar." },
    ],
  },
  {
    id: "onboarding",
    title: "Onboarding flow copy",
    messages: [
      { role: "user", content: "Tighten the three onboarding steps." },
      { role: "assistant", content: "Trimmed to: Choose your agent, Connect your apps, Stay on top. Each line is now under nine words." },
    ],
  },
];

const CYCLE_MS = 2600;

/** Self-driving demo: cycles through conversations so the rail pill and thread animate on their own. */
export function ChatAppDemo() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % DEMO_CONVERSATIONS.length), CYCLE_MS);
    return () => clearInterval(id);
  }, []);

  // Reorder so the driven conversation is the first row, keeping the active pill in motion.
  const ordered = [
    DEMO_CONVERSATIONS[index],
    ...DEMO_CONVERSATIONS.slice(0, index),
    ...DEMO_CONVERSATIONS.slice(index + 1),
  ];

  return (
    <div className="flex items-center justify-center rounded-xl bg-bg-weak-50 p-3">
      <div className="w-full max-w-3xl">
        <ChatApp key={index} conversations={ordered} />
      </div>
    </div>
  );
}

export default ChatAppDemo;
