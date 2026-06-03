// Ported from beui.dev registry "citations" (components/agents/citations.tsx +
// agent-disclosure, lib/ease, lib/favicon inlined). Re-expressed with our tokens +
// Remixicon. Inline citation markers paired with a collapsible, progressively rendered
// reference collection.
"use client";

import { RiArrowDownSLine, RiBookOpenLine, RiExternalLinkLine, RiGlobalLine } from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { type CSSProperties, type ReactNode, useCallback, useId, useState } from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
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

export interface CitationItem {
  id: string;
  title: ReactNode;
  domain?: ReactNode;
  url?: string;
}

function citationTargetId(prefix: string, citationId: string) {
  return `${prefix}-${citationId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
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

/** Inline citation marker - a small numbered chip that jumps to the matching source row. */
export function Citation({
  citationId,
  index,
  idPrefix,
  className,
}: {
  citationId: string;
  index: number;
  idPrefix: string;
  className?: string;
}) {
  return (
    <a
      href={`#${citationTargetId(idPrefix, citationId)}`}
      aria-label={`View citation ${index}`}
      className={cx(
        "mx-0.5 inline-flex min-w-4 -translate-y-0.5 items-center justify-center rounded-md bg-background-secondary-default px-1 py-0.5 text-[10px] font-semibold leading-none text-text-secondary no-underline outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        className,
      )}
    >
      {index}
    </a>
  );
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

/** Collapsible list of sources with favicons, feed it `citations`. */
export function SourcesPanel({
  citations,
  title = "Sources",
  defaultOpen = false,
  idPrefix,
  className,
}: {
  citations: CitationItem[];
  title?: ReactNode;
  defaultOpen?: boolean;
  idPrefix?: string;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const contentId = `${baseId}-content`;
  const resolvedPrefix = idPrefix ?? `citation-${baseId.replace(/:/g, "")}`;
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  return (
    <div className={cx("w-full text-body-2-regular", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
        className="group -ml-1 flex min-h-8 items-center gap-2 rounded-lg px-1 text-left text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiBookOpenLine className="size-4" />
        <span className="font-medium">{title}</span>
        <span className="rounded-full bg-background-secondary-default px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
          {citations.length}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="text-text-tertiary"
        >
          <RiArrowDownSLine className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure id={contentId} open={open}>
        <CitationList citations={citations} idPrefix={resolvedPrefix} className="mt-1" />
      </AgentDisclosure>
    </div>
  );
}

const DEMO_CITATIONS: CitationItem[] = [
  { id: "attention", title: "Attention Is All You Need", domain: "arxiv.org", url: "https://arxiv.org/abs/1706.03762" },
  { id: "useid", title: "useId - React reference", domain: "react.dev", url: "https://react.dev/reference/react/useId" },
  {
    id: "clip-path",
    title: "clip-path - CSS reference",
    domain: "developer.mozilla.org",
    url: "https://developer.mozilla.org/en-US/docs/Web/CSS/clip-path",
  },
  { id: "retrieval", title: "Retrieval-Augmented Generation", domain: "arxiv.org", url: "https://arxiv.org/abs/2005.11401" },
];

const DEMO_PREFIX = "citations-demo";

/** Self-contained demo: a grounded paragraph with inline markers over a collapsible source list. */
export function CitationsDemo() {
  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <p className="text-[13px] leading-relaxed text-text-primary">
          Transformer models replace recurrence with self-attention
          <Citation citationId="attention" index={1} idPrefix={DEMO_PREFIX} />, letting every token attend to the full
          sequence in parallel. React ships a stable, SSR-safe id hook
          <Citation citationId="useid" index={2} idPrefix={DEMO_PREFIX} /> and the disclosure below animates open with a
          pure CSS clip-path reveal
          <Citation citationId="clip-path" index={3} idPrefix={DEMO_PREFIX} />. Grounding answers in retrieved passages
          keeps them verifiable
          <Citation citationId="retrieval" index={4} idPrefix={DEMO_PREFIX} />.
        </p>

        <div className="mt-3">
          <SourcesPanel citations={DEMO_CITATIONS} idPrefix={DEMO_PREFIX} defaultOpen />
        </div>
      </div>
    </div>
  );
}

export default CitationsDemo;
