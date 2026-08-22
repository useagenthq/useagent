"use client";

import { useState, type ReactNode } from "react";
import { RiArrowDownSLine, RiCalendarLine, RiCheckLine } from "@remixicon/react";
import { Chip } from "@/components/base/badges/chip";
import {
  Dropdown,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { useCountUp } from "@/hooks/use-count-up";
import { cx } from "@/utils/cx";

/**
 * Shared chrome for the radar / radial / funnel / sankey chart cards: the
 * card shell, the label + count-up headline + delta chip header, the
 * optional range pill, an absolutely centred readout for the ring charts,
 * and a swatch legend. Everything is derived from the same tokens the
 * dashboard and medical chart cards use, so the new cards sit next to them
 * without any tuning.
 */

/* ---------------------------------------------------------------- palette */

export type ChartTone = { color: string; activeColor: string };

/**
 * Default series palette, cycling through the `chart-n` tokens in an order
 * that keeps neighbouring series distinct: lime (the dashboard accent), blue,
 * purple, pink, yellow, emerald, sky, teal. Each tone pairs the 400 fill
 * with its 500 hover step - the same recipe every existing chart card uses.
 */
const TONE_ORDER = [2, 6, 5, 3, 8, 7, 4, 1] as const;

export const CHART_TONES: ChartTone[] = TONE_ORDER.map((n) => ({
  color: `var(--color-chart-${n})`,
  activeColor: `var(--color-chart-${n}-active)`,
}));

/**
 * Resolves an item's colours: explicit `color` (+ optional `activeColor`)
 * wins; otherwise the palette entry for its index. A custom colour without
 * a hover step is darkened with `color-mix` so hover still reads.
 */
export function resolveTone(index: number, color?: string, activeColor?: string): ChartTone {
  if (color) {
    return { color, activeColor: activeColor ?? `color-mix(in srgb, ${color} 82%, black)` };
  }
  return CHART_TONES[index % CHART_TONES.length];
}

/**
 * Single-ink tone for the `mono` looks. Dark mode mirrors the reference
 * (near-white bands on the dark card); light mode uses a mid grey rather
 * than the full text black so the bands stay light against the card.
 * `light-dark()` follows the `color-scheme` globals.css sets on `html` /
 * `html.dark`.
 */
export const MONO_TONE: ChartTone = {
  color: "light-dark(var(--color-neutral-500), color-mix(in srgb, var(--color-neutral-50) 84%, transparent))",
  activeColor: "light-dark(var(--color-neutral-600), var(--color-neutral-50))",
};

export type DeltaColor = "lime" | "rose" | "neutral";

/** Formats a delta ratio (`0.052` → `+5.2%`) and picks the chip colour. */
export function describeDelta(delta: number): { label: string; color: DeltaColor } {
  const pct = Math.round(Math.abs(delta) * 1000) / 10;
  if (pct === 0) return { label: "0.0%", color: "neutral" };
  return { label: `${delta > 0 ? "+" : "-"}${pct}%`, color: delta > 0 ? "lime" : "rose" };
}

export const formatNumber = (n: number) => n.toLocaleString("en-US");

/** Decimal places a value carries (capped at 2), so fractional data such as
 *  "48.8h" keeps its precision through the integer-stepping count-up. */
function decimalsOf(n: number) {
  if (Number.isInteger(n)) return 0;
  return Math.abs(n * 10 - Math.round(n * 10)) < 1e-6 ? 1 : 2;
}

/** `useCountUp` that preserves up to two decimals by counting in scaled units. */
function useCountUpPrecise(value: number) {
  const scale = 10 ** decimalsOf(value);
  const display = useCountUp(Math.round(value * scale));
  return display / scale;
}

/* ------------------------------------------------------------------ shell */

export function ChartCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cx(
        "flex h-[329px] w-full min-w-0 flex-col gap-4 rounded-2xl bg-background-secondary-default px-4 pt-4 pb-3",
        className,
      )}
    >
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- header */

export function ChartHeader({
  label,
  value,
  format = formatNumber,
  delta,
  hovering = false,
  fadeKey,
  range,
  ranges,
  rangeId,
  onRangeChange,
  trailing,
  className,
}: {
  /** Secondary line above the headline - swaps to the hovered item's name. */
  label: string;
  /** Headline number; animates between values with `useCountUp`. Omit for a
   *  single-line header (the ring charts keep their number in the centre). */
  value?: number;
  format?: (n: number) => string;
  /** Delta chip beside the headline; hidden while `hovering` so the hovered
   *  value stands alone, matching the other chart cards. */
  delta?: { label: string; color: DeltaColor };
  hovering?: boolean;
  /** Changing this key restarts the headline's fade, e.g. `String(activeIndex)`. */
  fadeKey?: string;
  /** Static period pill on the right ("Jan – Jun 2024"). Ignored when
   *  `ranges` is set. */
  range?: string;
  /** Selectable periods - renders the pill as a dropdown. */
  ranges?: ChartRangeOption[];
  rangeId?: string;
  onRangeChange?: (id: string) => void;
  /** Any other trailing control (rendered instead of / next to `range`). */
  trailing?: ReactNode;
  className?: string;
}) {
  const display = useCountUpPrecise(value ?? 0);
  return (
    <div className={cx("flex w-full items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="w-full truncate text-body-medium text-text-secondary">{label}</p>
        {value !== undefined && (
          <div className="flex w-full items-center gap-2">
            <p
              key={fadeKey}
              className="animate-number-fade text-title-1-medium whitespace-nowrap text-text-primary tabular-nums"
            >
              {format(display)}
            </p>
            {delta && (
              <Chip variant="bold" color={delta.color} className={hovering ? "invisible" : undefined}>
                {delta.label}
              </Chip>
            )}
          </div>
        )}
      </div>
      {trailing}
      {ranges && ranges.length > 0 ? (
        <ChartRangeSelect ranges={ranges} value={rangeId} onChange={onRangeChange} />
      ) : (
        range && <ChartRangePill label={range} />
      )}
    </div>
  );
}

/**
 * Static period pill - the medical cards' `WeekRangePill` chrome (32px,
 * radius/2lg, button border, primary background, shadow/xs) with a calendar
 * glyph instead of the decorative chevrons, so the chart packages don't pull
 * the date-picker helpers along.
 */
const RANGE_PILL =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-2lg border border-border-button-default bg-background-primary-default pr-2.5 pl-2 shadow-xs";

export function ChartRangePill({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cx(RANGE_PILL, className)}>
      <RiCalendarLine className="size-4 shrink-0 text-text-secondary" aria-hidden />
      <span className="text-body-medium whitespace-nowrap text-text-primary">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ ranges */

export type ChartRangeOption = { id: string; label: string };

/**
 * A card's selectable period: the pill label plus whichever of the card's
 * data props that period overrides (data, stages, delta, headline…). Fields
 * left out fall back to the card's top-level props.
 */
export type ChartRange<T extends object = object> = ChartRangeOption & Partial<T>;

/**
 * Selection state for `ranges`. Uncontrolled (first range, or `defaultId`);
 * `onChange` reports selections so a host can fetch real data for the new
 * period if it wants to.
 */
export function useChartRange<T extends object>(
  ranges: ChartRange<T>[] | undefined,
  defaultId?: string,
  onChange?: (id: string) => void,
) {
  const [selectedId, setSelectedId] = useState<string | undefined>(defaultId);
  const selected = ranges?.find((r) => r.id === selectedId) ?? ranges?.[0];
  const select = (id: string) => {
    setSelectedId(id);
    onChange?.(id);
  };
  return { selected, selectedId: selected?.id, select };
}

/**
 * The period pill as a dropdown: same chrome as `ChartRangePill` plus a
 * chevron that flips while open, and a menu of ranges with a check on the
 * current one - the BoardUI Dropdown recipe, sized to the pill.
 */
export function ChartRangeSelect({
  ranges,
  value,
  onChange,
  className,
}: {
  ranges: ChartRangeOption[];
  value?: string;
  onChange?: (id: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = ranges.find((r) => r.id === value) ?? ranges[0];
  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <DropdownTrigger
        aria-label="Change period"
        className={cx(
          RANGE_PILL,
          "pr-1.5 transition-colors duration-150 ease-out hover:bg-background-primary-hover",
          className,
        )}
      >
        <RiCalendarLine className="size-4 shrink-0 text-text-secondary" aria-hidden />
        <span className="text-body-medium whitespace-nowrap text-text-primary">{current?.label}</span>
        <RiArrowDownSLine
          className={cx(
            "size-4 shrink-0 text-text-secondary transition-transform duration-200 ease-out",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </DropdownTrigger>
      <DropdownPopover aria-label="Period" placement="bottom end" className="w-[188px] p-2" dialogClassName="gap-1">
        {ranges.map((r) => {
          const selected = r.id === current?.id;
          return (
            <DropdownItem
              key={r.id}
              selected={selected}
              className="px-2 py-1.5"
              onSelect={() => {
                onChange?.(r.id);
                setOpen(false);
              }}
            >
              <span className="flex-1 text-body-medium">{r.label}</span>
              {selected && <RiCheckLine className="size-4 shrink-0 text-text-secondary" aria-hidden />}
            </DropdownItem>
          );
        })}
      </DropdownPopover>
    </Dropdown>
  );
}

/* --------------------------------------------------------- centre readout */

/**
 * The number inside a ring chart. Absolutely centred over the chart area,
 * pointer-events off so hovering the arcs underneath still works.
 */
export function ChartCenterReadout({
  value,
  format = formatNumber,
  caption,
  fadeKey,
  size = "display",
  className,
}: {
  value: number;
  format?: (n: number) => string;
  caption?: string;
  fadeKey?: string;
  /** `display` (32px) for the big single-value gauges, `title` (24px) where
   *  the hole is smaller. */
  size?: "display" | "title";
  /** Override the centring, e.g. `justify-end` to sit on a half gauge's base. */
  className?: string;
}) {
  const display = useCountUpPrecise(value);
  return (
    <div
      className={cx(
        "pointer-events-none absolute inset-0 flex flex-col items-center justify-center",
        className,
      )}
    >
      <span
        key={fadeKey}
        className={cx(
          "animate-number-fade text-text-primary tabular-nums",
          size === "display" ? "text-display-4-medium" : "text-title-1-medium",
        )}
      >
        {format(display)}
      </span>
      {caption && (
        <span
          key={`caption:${fadeKey}`}
          className="animate-number-fade -mt-1 max-w-[120px] truncate text-caption-1-medium text-text-tertiary"
        >
          {caption}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- stat tiles */

export type StatTile = { label: string; value: string; color?: string; activeColor?: string };

/**
 * The stat tile row under a chart: swatch · name over value per item (the
 * activity rings tile recipe), on a six-column grid - three per row, with the
 * last row's remainder stretched to full width (5 → 3 + 2, 4 → 3 + 1). The
 * grid bleeds 8px past the card padding on the sides and bottom so the tiles
 * read wider than the chart above. Hovering a tile focuses its item.
 */
export function ChartStatTiles({
  items,
  activeIndex = null,
  onActiveChange,
  className,
}: {
  items: StatTile[];
  activeIndex?: number | null;
  onActiveChange?: (index: number | null) => void;
  className?: string;
}) {
  const hovering = activeIndex !== null;
  const remainder = items.length % 3;
  return (
    <div className={cx("-mx-2 -mb-1 grid grid-cols-6 gap-2", className)}>
      {items.map((item, i) => {
        const active = activeIndex === i;
        const inLastRow = remainder > 0 && i >= items.length - remainder;
        const span = inLastRow ? 6 / remainder : 2;
        return (
          <div
            key={`${item.label}-${i}`}
            className="flex min-w-0 flex-col items-start gap-px rounded-2lg bg-background-inner-default px-2.5 py-2 transition-opacity duration-200 ease-out"
            style={{ gridColumn: `span ${span} / span ${span}`, opacity: hovering && !active ? 0.4 : 1 }}
            onMouseEnter={onActiveChange ? () => onActiveChange(i) : undefined}
            onMouseLeave={onActiveChange ? () => onActiveChange(null) : undefined}
          >
            <div className="flex min-w-0 max-w-full items-center gap-1.5">
              {item.color && (
                <span
                  className="size-3 shrink-0 rounded-[4px] transition-colors duration-150 ease-out"
                  style={{ backgroundColor: active && item.activeColor ? item.activeColor : item.color }}
                />
              )}
              <span className="truncate text-body-regular text-text-secondary">{item.label}</span>
            </div>
            <span className="text-body-medium whitespace-nowrap text-text-primary tabular-nums">{item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------- legend */

export type LegendItem = { label: string; color: string; value?: string };

export function ChartLegend({
  items,
  activeIndex = null,
  onActiveChange,
  className,
}: {
  items: LegendItem[];
  activeIndex?: number | null;
  /** Hovering a legend row focuses its series/segment, like the chart itself. */
  onActiveChange?: (index: number | null) => void;
  className?: string;
}) {
  return (
    <div className={cx("flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-1", className)}>
      {items.map((item, index) => {
        const dimmed = activeIndex !== null && activeIndex !== index;
        return (
          <div
            key={item.label}
            className={cx(
              "flex items-center gap-1.5 transition-opacity duration-200 ease-out",
              dimmed && "opacity-50",
            )}
            onMouseEnter={onActiveChange ? () => onActiveChange(index) : undefined}
            onMouseLeave={onActiveChange ? () => onActiveChange(null) : undefined}
          >
            <span className="size-3 shrink-0 rounded-[4px]" style={{ backgroundColor: item.color }} />
            <span className="text-body-regular whitespace-nowrap text-text-secondary">{item.label}</span>
            {item.value !== undefined && (
              <span className="text-body-medium whitespace-nowrap text-text-primary tabular-nums">
                {item.value}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
