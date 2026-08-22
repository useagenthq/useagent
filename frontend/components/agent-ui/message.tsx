// Ported from beui.dev registry "message" (components/agents/message.tsx +
// message-context, lib/ease inlined). Re-expressed with our AlignUI tokens + Remixicon.
// A role-aware chat message row (avatar + header + markdown-ish bubble + footer) with a
// mount pop-in, a lightweight inline markdown renderer, a typing indicator, and a
// copy-to-clipboard footer action. No react-markdown dep - a small CSS/motion renderer.
"use client";

import {
  RiCheckLine,
  RiFileCopyLine,
  RiSparkling2Line,
  RiUser3Line,
} from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ComponentPropsWithRef,
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { cn } from "@/utils/cn";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
// A sent row should rise from the live edge without changing measured layout.
const MESSAGE_POP_UP = { type: "spring", stiffness: 480, damping: 32, mass: 0.62 } as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;

// -- message context -------------------------------------------------------
type MessageFrom = "user" | "assistant";

const MessageContext = createContext<{ from: MessageFrom }>({ from: "assistant" });

interface MessageProps extends Omit<ComponentPropsWithRef<typeof motion.article>, "children"> {
  from: MessageFrom;
  /** Plays a trailing-edge pop-up once when this message row mounts. */
  animateIn?: boolean;
  children: ReactNode;
}

/** Role-aware message row: aligns to the live edge and pops in on mount. */
export function Message({
  from,
  animateIn = false,
  children,
  className,
  style,
  ...props
}: MessageProps) {
  const reduce = useReducedMotion() ?? false;

  return (
    <MessageContext.Provider value={{ from }}>
      <motion.article
        data-slot="message"
        data-from={from}
        aria-label={props["aria-label"] ?? `${from} message`}
        initial={animateIn && !reduce ? { opacity: 0, y: 8, scale: 0.95 } : false}
        animate={animateIn && !reduce ? { opacity: 1, y: 0, scale: 1 } : { opacity: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.99 }}
        transition={reduce ? { duration: 0.12 } : MESSAGE_POP_UP}
        style={{ transformOrigin: from === "user" ? "100% 100%" : "0% 100%", ...style }}
        className={cn(
          "group/message flex w-full items-start gap-2",
          from === "user" ? "flex-row-reverse" : "flex-row",
          className,
        )}
        {...props}
      >
        {children}
      </motion.article>
    </MessageContext.Provider>
  );
}

interface MessageGroupProps extends ComponentPropsWithRef<"div"> {
  spacing?: "compact" | "default";
}

/** Vertical stack of message rows. */
export function MessageGroup({ spacing = "default", className, ...props }: MessageGroupProps) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex w-full flex-col", spacing === "compact" ? "gap-1.5" : "gap-4", className)}
      {...props}
    />
  );
}

interface MessageAvatarProps extends ComponentPropsWithRef<"div"> {
  /** Keep an empty avatar slot so grouped messages remain aligned. */
  placeholder?: boolean;
}

/** Round avatar slot; falls back to a role glyph when empty. */
export function MessageAvatar({ placeholder = false, children, className, ...props }: MessageAvatarProps) {
  const { from } = useContext(MessageContext);
  const fallback = from === "user" ? <RiUser3Line /> : <RiSparkling2Line />;

  return (
    <div
      data-slot="message-avatar"
      aria-hidden={placeholder || undefined}
      className={cn(
        "grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-bg-weak-50 text-[11px] font-medium text-text-sub-600 [&_img]:size-full [&_img]:object-cover [&_svg]:size-3.5",
        from === "assistant" && "text-primary-base",
        placeholder && "invisible",
        className,
      )}
      {...props}
    >
      {children ?? fallback}
    </div>
  );
}

/** Content column - aligns its children to the live edge for the current role. */
export function MessageContent({ className, ...props }: ComponentPropsWithRef<"div">) {
  const { from } = useContext(MessageContext);

  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1.5",
        from === "user" ? "items-end" : "items-start",
        className,
      )}
      {...props}
    />
  );
}

/** Small attribution line above the bubble (name, timestamp). */
export function MessageHeader({ className, ...props }: ComponentPropsWithRef<"div">) {
  const { from } = useContext(MessageContext);

  return (
    <div
      data-slot="message-header"
      className={cn(
        "flex items-center gap-1.5 px-1 text-[11px] leading-none text-text-sub-600",
        from === "user" ? "justify-end" : "justify-start",
        className,
      )}
      {...props}
    />
  );
}

/** Row under the bubble for typing dots, copy actions, or metadata. */
export function MessageFooter({ className, ...props }: ComponentPropsWithRef<"div">) {
  const { from } = useContext(MessageContext);

  return (
    <div
      data-slot="message-footer"
      className={cn(
        "flex min-h-5 items-center gap-1 px-1 text-[11px] text-text-soft-400",
        from === "user" ? "justify-end" : "justify-start",
        className,
      )}
      {...props}
    />
  );
}

/** Centered system marker chip between rows (context added, day divider, etc). */
export function MessageMarker({ className, ...props }: ComponentPropsWithRef<"div">) {
  return (
    <div
      data-slot="message-marker"
      className={cn(
        "mx-auto flex w-fit max-w-[88%] items-center gap-1.5 rounded-full bg-bg-weak-50 px-2.5 py-1 text-center text-paragraph-xs text-text-sub-600",
        className,
      )}
      {...props}
    />
  );
}

interface MessageTypingProps extends ComponentPropsWithRef<"span"> {
  label?: string;
}

/** Three-dot typing indicator. */
export function MessageTyping({ label = "Responding", className, ...props }: MessageTypingProps) {
  const reduce = useReducedMotion() ?? false;

  return (
    <span data-slot="message-typing" className={cn("inline-flex h-5 items-center gap-1", className)} {...props}>
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((index) => (
        <motion.span
          key={index}
          aria-hidden="true"
          className="size-1 rounded-full bg-current"
          animate={reduce ? { opacity: 0.45 } : { opacity: [0.28, 0.85, 0.28], y: [0, -2, 0] }}
          transition={{
            duration: 1.05,
            ease: EASE_OUT,
            repeat: Number.POSITIVE_INFINITY,
            delay: index * 0.14,
          }}
        />
      ))}
    </span>
  );
}

// -- markdown-ish renderer -------------------------------------------------
// A tiny, dependency-free renderer: fenced code blocks, plus inline bold,
// `code`, and [links](url). Not a full parser - just enough for chat bubbles.
type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; value: string; href: string };

const INLINE_PATTERN = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) tokens.push({ kind: "text", value: text.slice(lastIndex, start) });
    if (match[1] !== undefined) tokens.push({ kind: "bold", value: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "code", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: "link", value: match[3], href: match[4] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) tokens.push({ kind: "text", value: text.slice(lastIndex) });
  return tokens;
}

function InlineMarkdown({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeInline(text), [text]);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === "bold") {
          return (
            <strong key={index} className="font-semibold">
              {token.value}
            </strong>
          );
        }
        if (token.kind === "code") {
          return (
            <code
              key={index}
              className="rounded bg-bg-weak-50 px-1 py-0.5 font-mono text-[0.9em] text-text-strong-950"
            >
              {token.value}
            </code>
          );
        }
        if (token.kind === "link") {
          return (
            <a
              key={index}
              href={token.href}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-primary-base underline underline-offset-2 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
            >
              {token.value}
            </a>
          );
        }
        return <Fragment key={index}>{token.value}</Fragment>;
      })}
    </>
  );
}

type Block =
  | { kind: "code"; lang?: string; value: string }
  | { kind: "paragraph"; value: string };

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const fencePattern = /```(\w+)?\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of content.matchAll(fencePattern)) {
    const start = match.index ?? 0;
    const before = content.slice(cursor, start).trim();
    if (before) blocks.push({ kind: "paragraph", value: before });
    blocks.push({ kind: "code", lang: match[1], value: match[2].replace(/\n$/, "") });
    cursor = start + match[0].length;
  }
  const rest = content.slice(cursor).trim();
  if (rest) blocks.push({ kind: "paragraph", value: rest });
  return blocks;
}

/** Renders the message body: fenced code blocks + inline markdown paragraphs. */
export function MessageMarkdown({ content, className }: { content: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-3 font-mono text-[13px] leading-relaxed text-text-strong-950"
          >
            <code>{block.value}</code>
          </pre>
        ) : (
          <p key={index} className="whitespace-pre-wrap leading-6">
            {block.value.split("\n").map((line, lineIndex, lines) => (
              <Fragment key={lineIndex}>
                <InlineMarkdown text={line} />
                {lineIndex < lines.length - 1 ? <br /> : null}
              </Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

interface MessageBubbleProps {
  content: string;
  className?: string;
}

/** The chat bubble: user rows get a filled bubble, assistant rows read inline. */
export function MessageBubble({ content, className }: MessageBubbleProps) {
  const { from } = useContext(MessageContext);

  return (
    <div
      data-slot="message-bubble"
      className={cn(
        "max-w-[82%] text-paragraph-sm",
        from === "user"
          ? "rounded-2xl bg-primary-base px-3.5 py-2.5 text-static-white"
          : "rounded-2xl bg-bg-weak-50 px-3.5 py-2.5 text-text-strong-950",
        className,
      )}
    >
      <MessageMarkdown content={content} />
    </div>
  );
}

/** Copy-to-clipboard footer action with a check-mark confirmation swap. */
export function MessageCopyButton({ value, className }: { value: string; className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (insecure context); fail silently.
    }
  }, [value]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : "Copy message"}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-text-soft-400 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-sub-600 focus-visible:ring-2 focus-visible:ring-stroke-strong-950",
        className,
      )}
    >
      <span className="relative grid size-3.5 place-items-center">
        <AnimatePresence initial={false} mode="popLayout">
          {copied ? (
            <motion.span
              key="check"
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
              className="absolute text-success-base"
            >
              <RiCheckLine className="size-3.5" />
            </motion.span>
          ) : (
            <motion.span
              key="copy"
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
              className="absolute"
            >
              <RiFileCopyLine className="size-3.5" />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// -- self-driving demo -----------------------------------------------------
interface DemoTurn {
  id: string;
  from: MessageFrom;
  name: string;
  time: string;
  content: string;
  marker?: string;
}

const DEMO_TURNS: DemoTurn[] = [
  {
    id: "q",
    from: "user",
    name: "You",
    time: "9:41 AM",
    content: "Can you pull the latest churn numbers by **segment**?",
    marker: "Context added · churn-q3.csv (18 pages)",
  },
  {
    id: "a",
    from: "assistant",
    name: "Assistant",
    time: "9:41 AM",
    content:
      "Churn held at **2.1%** this month, down 0.3pts. Mid-market drove the improvement. Run `bun run report` to regenerate, or open the [dashboard](https://example.com).\n\n```sql\nSELECT segment, churn_rate\nFROM metrics\nWHERE month = '2026-08';\n```",
  },
];

const STEP_MS = 2600;

/** Self-driving demo: replays a two-turn conversation, showing the typing state
 * before the assistant reply lands, then loops. */
export function MessageDemo() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % 3), STEP_MS);
    return () => clearInterval(id);
  }, []);

  // step 0: user only · step 1: user + assistant typing · step 2: full reply
  const showAssistant = step >= 1;
  const assistantThinking = step === 1;

  return (
    <div className="flex items-center justify-center rounded-xl bg-bg-weak-50 p-3">
      <div className="w-full max-w-md">
        <MessageGroup>
          <AnimatePresence mode="popLayout">
            <Message key="user" from="user" animateIn>
              <MessageAvatar>AB</MessageAvatar>
              <MessageContent>
                <MessageHeader>
                  <span className="font-medium text-text-strong-950">{DEMO_TURNS[0].name}</span>
                  <span>·</span>
                  <span>{DEMO_TURNS[0].time}</span>
                </MessageHeader>
                <MessageBubble content={DEMO_TURNS[0].content} />
              </MessageContent>
            </Message>

            {DEMO_TURNS[0].marker ? (
              <MessageMarker key="marker">{DEMO_TURNS[0].marker}</MessageMarker>
            ) : null}

            {showAssistant ? (
              <Message key="assistant" from="assistant" animateIn>
                <MessageAvatar />
                <MessageContent>
                  <MessageHeader>
                    <span className="font-medium text-text-strong-950">{DEMO_TURNS[1].name}</span>
                  </MessageHeader>
                  {assistantThinking ? (
                    <div className="rounded-2xl bg-bg-weak-50 px-3.5 py-2.5 text-text-sub-600">
                      <MessageTyping />
                    </div>
                  ) : (
                    <>
                      <MessageBubble content={DEMO_TURNS[1].content} />
                      <MessageFooter>
                        <MessageCopyButton value={DEMO_TURNS[1].content} />
                      </MessageFooter>
                    </>
                  )}
                </MessageContent>
              </Message>
            ) : null}
          </AnimatePresence>
        </MessageGroup>
      </div>
    </div>
  );
}

export default MessageDemo;
