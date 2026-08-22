"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { RiArrowDownSLine, RiComputerLine, RiSmartphoneLine, RiTabletLine } from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";
import { MONO_TONE, resolveTone } from "@/components/application/charts/chart-card";
import { Tab, TabList, TabPanel, Tabs } from "@/components/base/tabs/tabs";
import { cx } from "@/utils/cx";

/**
 * Bar list card - the analytics "breakdown" list (traffic by country, device,
 * browser, OS, referrer…): a ranked list where every row's background bar
 * encodes its share of the top item, with the label sitting on the bar and
 * the metric on the right. Tabs (our underline Tabs) switch between lists,
 * a caption on the same baseline names the metric, and lists longer than
 * `limit` fade out behind a small centred pill that expands the rest - the
 * card grows with them.
 *
 * `tabs` is `{ id, label, items }[]` (or pass `items` + `title` for a single
 * list); items are the same `{ label, value, color?, icon? }` shape as the
 * stage bars. Bars are a translucent tint of `color` (default chart-6) -
 * hovering a row deepens its tint. Values print as share of the tab total
 * by default (`<0.5%` under half a percent), or the raw value with
 * `metric="value"`.
 */

export type BarListItem = {
  label: string;
  value: number;
  /** Any CSS colour for this row's bar; defaults to the card `color`. */
  color?: string;
  /** Leading glyph (flag, favicon, icon). 16px box. */
  icon?: ReactNode;
};

export type BarListTab = { id: string; label: string; items: BarListItem[] };

export interface BarListCardProps {
  /** Tabbed lists. When only one list is needed, use `items` + `title`. */
  tabs?: BarListTab[];
  items?: BarListItem[];
  /** Heading for a single (untabbed) list. */
  title?: string;
  /** Column caption over the values ("Visitors"). */
  metricLabel?: string;
  /** Show each row's share of the tab total (default) or its raw value. */
  metric?: "share" | "value";
  format?: (n: number) => string;
  /** Tint for the bars; any CSS colour, defaults to chart-6 (blue). */
  color?: string;
  /** Single-ink tint (mid grey on light, near-white on dark). */
  mono?: boolean;
  /** Rows shown before the "more" pill (default 5). */
  limit?: number;
  defaultTab?: string;
  onTabChange?: (id: string) => void;
  className?: string;
}

const ICON = "size-4 text-text-secondary";

const DEFAULT_TABS: BarListTab[] = [
  {
    id: "devices",
    label: "Devices",
    items: [
      { label: "Desktop", value: 5980, icon: <RiComputerLine className={ICON} aria-hidden /> },
      { label: "Mobile", value: 3020, icon: <RiSmartphoneLine className={ICON} aria-hidden /> },
      { label: "Tablet", value: 820, icon: <RiTabletLine className={ICON} aria-hidden /> },
    ],
  },
  {
    id: "browsers",
    label: "Browsers",
    items: [
      { label: "Chrome", value: 5210 },
      { label: "Safari", value: 2640 },
      { label: "Firefox", value: 860 },
      { label: "Edge", value: 610 },
      { label: "Samsung Internet", value: 240 },
      { label: "Opera", value: 160 },
      { label: "Brave", value: 100 },
    ],
  },
  {
    id: "os",
    label: "Operating systems",
    items: [
      { label: "Mac", value: 4320 },
      { label: "iOS", value: 2550 },
      { label: "Windows", value: 1670 },
      { label: "Android", value: 880 },
      { label: "GNU/Linux", value: 390 },
      { label: "ChromeOS", value: 10 },
    ],
  },
  {
    id: "screens",
    label: "Screen sizes",
    items: [
      { label: "1920 × 1080", value: 3140 },
      { label: "1440 × 900", value: 2260 },
      { label: "390 × 844", value: 1980 },
      { label: "1536 × 864", value: 1120 },
      { label: "430 × 932", value: 760 },
      { label: "2560 × 1440", value: 560 },
    ],
  },
];

const formatNumber = (n: number) => n.toLocaleString("en-US");

/** Share label: whole percents, "<0.5%" for tiny slices, "0%" for zero. */
function shareLabel(value: number, total: number) {
  if (total <= 0 || value <= 0) return "0%";
  const pct = (value / total) * 100;
  if (pct < 0.5) return "<0.5%";
  return `${Math.round(pct)}%`;
}

/** Bars mount at 0 and grow (a timeout so the first frame is painted). */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);
  return mounted;
}

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Horizontal overflow fades for the tab strip: which edges have more tabs
 * hidden behind them. Re-measured on scroll and resize.
 */
function useScrollFades<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [fades, setFades] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      setFades({ left: el.scrollLeft > 1, right: max - el.scrollLeft > 1 });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, []);
  return { ref, fades };
}

/** CSS mask that fades whichever edges still hide content. */
function fadeMask(fades: { left: boolean; right: boolean }, size = 28) {
  if (!fades.left && !fades.right) return undefined;
  const from = fades.left ? `transparent, black ${size}px` : "black";
  const to = fades.right ? `black calc(100% - ${size}px), transparent` : "black";
  return `linear-gradient(to right, ${from}, ${to})`;
}

function BarRows({
  items,
  metric,
  format,
  tone,
  mono,
  limit,
  mounted,
}: {
  items: BarListItem[];
  metric: "share" | "value";
  format: (n: number) => string;
  tone: { color: string; activeColor: string };
  mono: boolean;
  limit: number;
  mounted: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  const total = items.reduce((s, i) => s + i.value, 0);
  const top = Math.max(1, ...items.map((i) => i.value));
  const overflow = items.length > limit;
  const visible = expanded || !overflow ? items : items.slice(0, limit);
  const rest = expanded || !overflow ? [] : items.slice(limit);

  const row = (item: BarListItem, index: number) => {
    const isActive = active === index;
    const itemTone = item.color && !mono ? resolveTone(index, item.color) : tone;
    // Tint: 14% at rest, 26% while hovered - the label always sits on top.
    const tint = `color-mix(in srgb, ${isActive ? itemTone.activeColor : itemTone.color} ${isActive ? 26 : 14}%, transparent)`;
    return (
      <div
        key={item.label}
        className="relative flex h-9 items-center justify-between gap-3 rounded-lg px-2.5"
        onMouseEnter={() => setActive(index)}
        onMouseLeave={() => setActive(null)}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-lg transition-[width,background-color] duration-500 ease-out"
          style={{ width: mounted ? `${(item.value / top) * 100}%` : 0, backgroundColor: tint }}
        />
        <span className="relative flex min-w-0 items-center gap-2">
          {item.icon && <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span>}
          <span className="truncate text-body-regular text-text-primary">{item.label}</span>
        </span>
        <span className="relative shrink-0 text-body-medium text-text-primary tabular-nums">
          {metric === "share" ? shareLabel(item.value, total) : format(item.value)}
        </span>
      </div>
    );
  };

  return (
    // Like the stat tiles under the funnel / stage bars, the rows pull 8px
    // past the card padding on the sides and bottom, so the header above
    // reads as the narrower, focused block.
    <div className="relative -mx-2 -mb-1 flex flex-col">
      <div
        className="flex flex-col gap-1"
        style={
          overflow && !expanded
            ? { maskImage: "linear-gradient(to bottom, black calc(100% - 44px), transparent)" }
            : undefined
        }
      >
        {visible.map(row)}
      </div>
      <AnimatePresence initial={false}>
        {expanded && overflow && (
          <motion.div
            key="rest"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-1 pt-1">{rest.map((item, i) => row(item, limit + i))}</div>
          </motion.div>
        )}
      </AnimatePresence>
      {overflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Show fewer" : `Show ${items.length - limit} more`}
          className={cx(
            "absolute left-1/2 flex h-5 w-10 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full",
            "border border-border-button-default bg-background-primary-default shadow-xs outline-none",
            "transition-colors duration-150 hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            expanded ? "-bottom-2" : "bottom-1",
          )}
        >
          <RiArrowDownSLine
            className={cx(
              "size-3.5 text-text-secondary transition-transform duration-200 ease-out",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      )}
    </div>
  );
}

export function BarListCard({
  tabs,
  items,
  title,
  metricLabel = "Visitors",
  metric = "share",
  format = formatNumber,
  color,
  mono = false,
  limit = 5,
  defaultTab,
  onTabChange,
  className,
}: BarListCardProps = {}) {
  const mounted = useMounted();
  const { ref: stripRef, fades } = useScrollFades<HTMLDivElement>();
  const tone = mono ? MONO_TONE : resolveTone(1, color); // palette index 1 = chart-6 blue
  const lists: BarListTab[] = tabs ?? (items ? [{ id: "list", label: title ?? "Breakdown", items }] : DEFAULT_TABS);
  const [selected, setSelected] = useState<string>(defaultTab ?? lists[0]?.id ?? "list");
  const single = lists.length === 1 && !tabs;

  const caption = (
    <span className="shrink-0 pb-2.5 text-caption-1-medium tracking-[0.06em] text-text-tertiary uppercase">
      {metricLabel}
    </span>
  );

  return (
    <section
      className={cx("flex w-full min-w-0 flex-col rounded-2xl bg-background-secondary-default px-4 pt-1 pb-3", className)}
    >
      {single ? (
        <>
          <div className="-mx-4 mb-3 flex items-end justify-between gap-3 border-b border-separator-border px-4">
            <span className="px-2.5 py-2 text-body-medium text-text-primary">{lists[0].label}</span>
            {caption}
          </div>
          <BarRows
            items={lists[0].items}
            metric={metric}
            format={format}
            tone={tone}
            mono={mono}
            limit={limit}
            mounted={mounted}
          />
        </>
      ) : (
        <Tabs
          selectedKey={selected}
          onSelectionChange={(key) => {
            setSelected(String(key));
            onTabChange?.(String(key));
          }}
          className="gap-3"
        >
          {/* The baseline runs edge to edge (-mx-4 / px-4) so it reads as the
              card's own rule rather than a line inside the content. */}
          <div className="-mx-4 flex items-end justify-between gap-3 border-b border-separator-border px-4">
            {/* The strip scrolls (swipe / trackpad) when the tabs outgrow the
                card, with a fade on whichever edge still hides tabs, so the
                metric caption never gets pushed out of the card. */}
            <div
              ref={stripRef}
              className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{ maskImage: fadeMask(fades), WebkitMaskImage: fadeMask(fades) }}
            >
              <TabList aria-label="Breakdown" className="w-max min-w-full border-b-0">
                {lists.map((tab) => (
                  <Tab key={tab.id} id={tab.id}>
                    {tab.label}
                  </Tab>
                ))}
              </TabList>
            </div>
            {caption}
          </div>
          {lists.map((tab) => (
            <TabPanel key={tab.id} id={tab.id}>
              <BarRows
                items={tab.items}
                metric={metric}
                format={format}
                tone={tone}
                mono={mono}
                limit={limit}
                mounted={mounted}
              />
            </TabPanel>
          ))}
        </Tabs>
      )}
    </section>
  );
}
