// Ported from beui.dev registry "ai-sidebar" (components/agents/ai-sidebar.tsx +
// motion/popover-morph, lib/ease inlined). Re-expressed with our AlignUI tokens +
// Remixicon. An assistant side-panel shell: a collapsible workspace tree with keyboard
// navigation, overflow-aware marquee labels, active selection, and a composer footer.
// The heavy optimistic drag-and-drop + portal morph-popover from the source were dropped
// in favor of a focused, self-driving demo per our simplicity bar.
"use client";

import {
  RiAddLine,
  RiArrowRightSLine,
  RiAttachmentLine,
  RiArrowUpLine,
  RiFileTextLine,
  RiFolder3Line,
  RiFolderOpenLine,
  RiSparkling2Line,
} from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_LAYOUT = { type: "spring", stiffness: 360, damping: 32, mass: 0.6 } as const;
const ROW_REVEAL = { duration: 0.16, ease: EASE_OUT } as const;

export type SidebarResourceKind = "folder" | "project" | "file";

export interface SidebarResource {
  id: string;
  label: string;
  kind: SidebarResourceKind;
  children?: SidebarResource[];
}

interface FlatResource {
  item: SidebarResource;
  depth: number;
  parentId: string | null;
}

function canContain(item: SidebarResource) {
  return item.kind === "folder" || item.kind === "project";
}

function flattenResources(
  items: SidebarResource[],
  expanded: Set<string>,
  depth = 0,
  parentId: string | null = null,
): FlatResource[] {
  return items.flatMap((item) => {
    const row = { item, depth, parentId };
    if (!item.children?.length || !expanded.has(item.id)) return [row];
    return [row, ...flattenResources(item.children, expanded, depth + 1, item.id)];
  });
}

function defaultIcon(item: SidebarResource, expanded: boolean) {
  if (canContain(item)) {
    return expanded ? (
      <RiFolderOpenLine className="size-4" />
    ) : (
      <RiFolder3Line className="size-4" />
    );
  }
  return <RiFileTextLine className="size-4" />;
}

// -- overflow-aware marquee label ------------------------------------------
function MarqueeLabel({ active, children }: { active: boolean; children: string }) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const label = labelRef.current;
      if (!viewport || !label) return;
      setDistance(label.scrollWidth > viewport.clientWidth ? label.scrollWidth + 24 : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (labelRef.current) observer.observe(labelRef.current);
    return () => observer.disconnect();
  }, []);

  const running = active && distance > 0 && !reduce;

  return (
    <span ref={viewportRef} className="block min-w-0 flex-1 overflow-hidden">
      <motion.span
        className="flex w-max items-center gap-6 whitespace-nowrap"
        animate={{ x: running ? [0, -distance] : 0 }}
        transition={
          running
            ? {
                duration: Math.max(2.4, distance / 34),
                ease: "linear",
                repeat: Number.POSITIVE_INFINITY,
                repeatDelay: 2,
              }
            : ROW_REVEAL
        }
      >
        <span ref={labelRef}>{children}</span>
        {running ? <span aria-hidden="true">{children}</span> : null}
      </motion.span>
    </span>
  );
}

// -- resource row ----------------------------------------------------------
function ResourceRow({
  row,
  active,
  expanded,
  focused,
  onSelect,
  onToggle,
  onFocus,
  onKeyDown,
  renderIcon,
  setRef,
}: {
  row: FlatResource;
  active: boolean;
  expanded: boolean;
  focused: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  renderIcon?: (item: SidebarResource) => ReactNode;
  setRef: (node: HTMLDivElement | null) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [hovered, setHovered] = useState(false);
  const acceptsChildren = canContain(row.item);

  return (
    <motion.div
      ref={setRef}
      layout="position"
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={acceptsChildren ? undefined : active}
      aria-expanded={acceptsChildren ? expanded : undefined}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={() => (acceptsChildren ? onToggle() : onSelect())}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cx(
        "group/resource relative flex min-h-9 min-w-0 cursor-pointer items-center gap-2.5 rounded-xl pr-2.5 text-body-2-regular outline-none",
        "text-text-secondary transition-colors hover:bg-background-primary-hover hover:text-text-primary",
        "focus-visible:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-inset",
        !acceptsChildren && active && "bg-background-secondary-default text-text-primary",
      )}
      style={{ paddingLeft: `${12 + row.depth * 16}px` }}
    >
      {acceptsChildren ? (
        <motion.span
          aria-hidden="true"
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
          className="grid size-4 shrink-0 place-items-center text-text-tertiary"
        >
          <RiArrowRightSLine className="size-4" />
        </motion.span>
      ) : (
        <span aria-hidden="true" className="size-4 shrink-0" />
      )}

      <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center text-text-tertiary">
        {renderIcon?.(row.item) ?? defaultIcon(row.item, expanded)}
      </span>

      <MarqueeLabel active={hovered}>{row.item.label}</MarqueeLabel>
    </motion.div>
  );
}

// -- resource tree ---------------------------------------------------------
/** Keyboard-navigable workspace tree. Feed it `items`; it flattens, expands,
 * and tracks active selection. Arrow keys move focus, Enter/Space toggle or select. */
export function AISidebarTree({
  items,
  defaultExpandedIds = [],
  activeId: controlledActiveId,
  defaultActiveId = null,
  onActiveChange,
  renderIcon,
  ariaLabel = "Resources",
  className,
}: {
  items: SidebarResource[];
  defaultExpandedIds?: string[];
  activeId?: string | null;
  defaultActiveId?: string | null;
  onActiveChange?: (id: string) => void;
  renderIcon?: (item: SidebarResource) => ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  const [expandedIds, setExpandedIds] = useState(() => new Set(defaultExpandedIds));
  const [internalActiveId, setInternalActiveId] = useState<string | null>(defaultActiveId);
  const [focusedId, setFocusedId] = useState<string | null>(defaultActiveId);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const activeId = controlledActiveId ?? internalActiveId;

  const flat = useMemo(() => flattenResources(items, expandedIds), [expandedIds, items]);

  useEffect(() => {
    if (focusedId && flat.some((row) => row.item.id === focusedId)) return;
    setFocusedId(flat[0]?.item.id ?? null);
  }, [flat, focusedId]);

  const focusRow = (id: string) => {
    setFocusedId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  const toggle = (id: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const select = (id: string) => {
    if (controlledActiveId === undefined) setInternalActiveId(id);
    onActiveChange?.(id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: FlatResource) => {
    const index = flat.findIndex(({ item }) => item.id === row.item.id);
    const previous = flat[index - 1];
    const next = flat[index + 1];

    if (event.key === "ArrowDown" && next) {
      event.preventDefault();
      focusRow(next.item.id);
    } else if (event.key === "ArrowUp" && previous) {
      event.preventDefault();
      focusRow(previous.item.id);
    } else if (event.key === "ArrowRight" && canContain(row.item)) {
      event.preventDefault();
      if (!expandedIds.has(row.item.id)) toggle(row.item.id);
      else if (next?.parentId === row.item.id) focusRow(next.item.id);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (expandedIds.has(row.item.id)) toggle(row.item.id);
      else if (row.parentId) focusRow(row.parentId);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (canContain(row.item)) toggle(row.item.id);
      else select(row.item.id);
    }
  };

  return (
    <div
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable="false"
      className={cx("relative flex min-w-0 flex-col gap-0.5 [overflow-anchor:none]", className)}
    >
      <AnimatePresence initial={false}>
        {flat.map((row) => (
          <ResourceRow
            key={row.item.id}
            row={row}
            active={activeId === row.item.id}
            expanded={expandedIds.has(row.item.id)}
            focused={focusedId === row.item.id}
            onSelect={() => select(row.item.id)}
            onToggle={() => toggle(row.item.id)}
            onFocus={() => setFocusedId(row.item.id)}
            onKeyDown={(event) => handleKeyDown(event, row)}
            renderIcon={renderIcon}
            setRef={(node) => {
              if (node) rowRefs.current.set(row.item.id, node);
              else rowRefs.current.delete(row.item.id);
            }}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Assistant side-panel shell: branded header, scrollable workspace tree, and a
 * composer footer. Compose `AISidebarTree` with your own header/footer for other layouts. */
export function AISidebar({
  items,
  title = "Workspace",
  placeholder = "Ask the agent anything",
  defaultExpandedIds,
  activeId,
  defaultActiveId,
  onActiveChange,
  className,
}: {
  items: SidebarResource[];
  title?: string;
  placeholder?: string;
  defaultExpandedIds?: string[];
  activeId?: string | null;
  defaultActiveId?: string | null;
  onActiveChange?: (id: string) => void;
  className?: string;
}) {
  return (
    <aside
      aria-label="Assistant panel"
      className={cx(
        "flex h-full w-full max-w-[280px] flex-col overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-sm",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-border-button-default px-3 py-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-background-secondary-default text-accent-500">
          <RiSparkling2Line className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
          {title}
        </span>
        <button
          type="button"
          aria-label="New resource"
          className="grid size-6 shrink-0 place-items-center rounded-lg text-text-tertiary outline-none transition-colors hover:bg-background-primary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiAddLine className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2" style={{ scrollbarWidth: "none" }}>
        <AISidebarTree
          items={items}
          defaultExpandedIds={defaultExpandedIds}
          activeId={activeId}
          defaultActiveId={defaultActiveId}
          onActiveChange={onActiveChange}
          ariaLabel={`${title} resources`}
        />
      </div>

      <footer className="border-t border-border-button-default p-2">
        <div className="flex items-center gap-1.5 rounded-xl border border-border-button-default bg-background-secondary-default px-2 py-1.5 transition-colors focus-within:border-border-focus-ring">
          <button
            type="button"
            aria-label="Attach file"
            className="grid size-6 shrink-0 place-items-center rounded-lg text-text-tertiary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            <RiAttachmentLine className="size-4" />
          </button>
          <input
            aria-label={placeholder}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder"
          />
          <button
            type="button"
            aria-label="Send message"
            className="grid size-6 shrink-0 place-items-center rounded-lg bg-button-primary text-text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            <RiArrowUpLine className="size-4" />
          </button>
        </div>
      </footer>
    </aside>
  );
}

const DEMO_ITEMS: SidebarResource[] = [
  {
    id: "workspace",
    label: "Agent workspace",
    kind: "project",
    children: [
      {
        id: "research",
        label: "Research",
        kind: "folder",
        children: [
          { id: "notes", label: "Field notes.md", kind: "file" },
          { id: "sources", label: "Sources and citations backlog.md", kind: "file" },
        ],
      },
      {
        id: "build",
        label: "Build",
        kind: "folder",
        children: [
          { id: "spec", label: "spec.md", kind: "file" },
          { id: "prompts", label: "prompts.ts", kind: "file" },
        ],
      },
      { id: "readme", label: "README, use arrow keys to navigate the tree", kind: "file" },
    ],
  },
  {
    id: "pinned",
    label: "Pinned",
    kind: "folder",
    children: [
      { id: "bm-tokens", label: "Design tokens", kind: "file" },
      { id: "bm-motion", label: "Motion guidelines", kind: "file" },
    ],
  },
];

const CYCLE = ["notes", "sources", "spec", "prompts", "readme", "bm-tokens", "bm-motion"];
const STEP_MS = 1600;

/** Self-driving demo: walks the active selection down the workspace tree, then loops. */
export function AISidebarDemo() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % CYCLE.length), STEP_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="h-[420px] w-full max-w-[280px]">
        <AISidebar
          items={DEMO_ITEMS}
          defaultExpandedIds={["workspace", "research", "build", "pinned"]}
          activeId={CYCLE[step]}
        />
      </div>
    </div>
  );
}

export default AISidebarDemo;
