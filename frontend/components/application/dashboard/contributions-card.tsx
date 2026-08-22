"use client";

import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { Chip } from "@/components/base/badges/chip";
import { SegmentedControl, SegmentedControlItem } from "@/components/base/segmented-control/segmented-control";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "Contributions this year" (node 3842:4786).
 *
 *   header    "Contributions this year" (Body 1/Medium) + "$7,462"
 *             (Title 1/Medium) + Chip bold/lime "+14.8%"
 *   stats     4 white cards (radius/2lg, shadow/card — same recipe as the
 *             hire cards on RecentHiresCard), value (Body 1/Medium) over
 *             label (Body 2/Medium secondary). Figma insets this row 8px
 *             from the card edge vs. 16px for everything else (`-mx-2` on
 *             top of the card's `p-4`), so it reads slightly wider.
 *   activity  "Activity" label + Weekly/Monthly/Yearly SegmentedControl
 *   grid      37 columns × 7 rows, 13px cells, 4px gap (`gap-1`), radius/md.
 *             neutral/300 = no activity that day. Colored cells use the
 *             `accent` family. Light mode deepens from 200 to 700; dark mode
 *             starts at the opposite, dark end of the ramp and brightens from
 *             950 to 500 as activity increases. No axis labels — the Figma
 *             frame doesn't have any.
 *
 * `accent` exists so /dev/contributions-colors can preview other color
 * families on the *real* component. The shared stylesheet maps each accent's
 * light and dark ramps so every consumer gets the same intensity direction.
 */

const STATS = [
  { value: "9B", label: "Lifetime tokens" },
  { value: "562.7M", label: "Peak tokens" },
  { value: "12h 54m", label: "Longest task" },
  { value: "62 days", label: "Top streak" },
];

const GRID_COLUMNS = 37;
const GRID_ROWS = 7;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const ACCENTS = ["emerald", "green", "teal", "cyan", "blue", "indigo", "violet", "rose", "amber"] as const;
export type Accent = (typeof ACCENTS)[number];

/**
 * Deterministic per-cell hash (SSR-safe — no Math.random/Date.now, so server
 * and client render identically). A plain linear seed like `row*7 + col*13`
 * reads as visibly diagonal/striped; this mixes the bits (multiply, xor-shift,
 * multiply, xor-shift — a small hash-combine) so the result looks properly
 * scattered instead of patterned.
 */
function hashCell(row: number, col: number) {
  let h = row * 374761393 + col * 668265263;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Activity tier 0 (none) → 5 (most), from the cell hash. */
function tierFor(row: number, col: number) {
  const seed = hashCell(row, col) % 20;
  if (seed < 6) return 0;
  if (seed < 11) return 1;
  if (seed < 15) return 2;
  if (seed < 18) return 3;
  if (seed < 19) return 4;
  return 5;
}

/** A plausible contribution count for the tooltip — deterministic, scaled by tier. */
const COUNT_BANDS: [number, number][] = [
  [0, 0],
  [1, 4],
  [5, 9],
  [10, 15],
  [16, 24],
  [25, 40],
];
function countFor(row: number, col: number) {
  const [lo, hi] = COUNT_BANDS[tierFor(row, col)];
  if (hi === 0) return 0;
  return lo + ((hashCell(row, col) >>> 3) % (hi - lo + 1));
}

/**
 * Map a cell to a date in the current year. Cells run column-major (each
 * column a "week", left→right through the year) so the label lines up with the
 * Jan→Dec axis: the first cell is Jan 1, the last is Dec 31.
 */
const YEAR = new Date().getFullYear();
function dateLabelFor(row: number, col: number, columns: number) {
  const cellIndex = col * GRID_ROWS + row;
  const dayOfYear = Math.round((cellIndex / (columns * GRID_ROWS - 1)) * 364);
  const d = new Date(Date.UTC(YEAR, 0, 1 + dayOfYear));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "12 contributions on April 26" / "No contributions on April 26". */
function tooltipLabel(row: number, col: number, columns: number) {
  const count = countFor(row, col);
  const date = dateLabelFor(row, col, columns);
  if (count === 0) return `No contributions on ${date}`;
  return `${count} contribution${count === 1 ? "" : "s"} on ${date}`;
}

/** Literal per-width classes so Tailwind keeps them (mobile fixed 13px cells
 *  that overflow-scroll, flexible 1fr tracks from `sm`). */
const COLUMN_CLASSES: Record<number, string> = {
  37: "grid-cols-[repeat(37,13px)] sm:grid-cols-[repeat(37,minmax(0,1fr))]",
  38: "grid-cols-[repeat(38,13px)] sm:grid-cols-[repeat(38,minmax(0,1fr))]",
};

/**
 * The bare heatmap grid — hash-scattered tiers, accent color ramp, and a
 * tooltip per cell. Extracted so other cards (e.g. the AI profile template)
 * render the exact same pattern instead of hardcoding cells.
 */
export function ContributionsGrid({
  columns = GRID_COLUMNS,
  accent = "violet",
  animateIn = false,
  className,
}: {
  /** 37 (dashboard card) or 38 (AI profile) — must exist in COLUMN_CLASSES. */
  columns?: number;
  accent?: Accent;
  /** Pop the colored cells in softly on mount, in scattered (hashed) order. */
  animateIn?: boolean;
  className?: string;
}) {
  return (
    <div
      data-accent={accent}
      className={cx("contributions-grid grid gap-1", COLUMN_CLASSES[columns] ?? COLUMN_CLASSES[GRID_COLUMNS], className)}
    >
      {Array.from({ length: GRID_ROWS }, (_, row) =>
        Array.from({ length: columns }, (_, col) => {
          const label = tooltipLabel(row, col, columns);
          const tier = tierFor(row, col);
          // Reuse the cell hash (different bits) for a scattered 0–800ms delay
          const pop = animateIn && tier > 0;
          return (
            <TooltipTrigger key={`${row}-${col}`} delay={0} closeDelay={0}>
              <AriaButton
                aria-label={label}
                excludeFromTabOrder
                data-tier={tier}
                className={cx(
                  "contribution-cell aspect-square w-full cursor-default rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                  pop && "animate-cell-pop",
                )}
                style={pop ? { animationDelay: `${(hashCell(row, col) >>> 7) % 800}ms` } : undefined}
              />
              <Tooltip>{label}</Tooltip>
            </TooltipTrigger>
          );
        }),
      )}
    </div>
  );
}

export function ContributionsCard({ accent = "violet", className }: { accent?: Accent; className?: string }) {
  const [period, setPeriod] = useState("weekly");

  return (
    <section
      className={cx(
        "flex h-auto min-w-0 flex-1 flex-col gap-4 overflow-hidden rounded-2xl bg-background-secondary-default p-4 sm:h-[337px]",
        className,
      )}
    >
      {/* Header */}
      <div className="flex w-full flex-col gap-0.5">
        <p className="w-full text-body-medium text-text-secondary">Contributions this year</p>
        <div className="flex w-full items-center gap-2">
          <p className="text-title-1-medium whitespace-nowrap text-text-primary">$7,462</p>
          <Chip variant="bold" color="lime">
            +14.8%
          </Chip>
        </div>
      </div>

      {/* Stats — inset 8px (-mx-2 on top of the card's p-4 = 16px), 8px narrower than everything else.
          Mobile stacks them into a 2×2 grid so the labels fit; from sm they're a single row. */}
      <div className="-mx-2 grid grid-cols-2 gap-2 sm:flex sm:items-stretch">
        {STATS.map((stat) => (
          <div
            key={stat.label}
            className="flex min-w-0 flex-col items-start rounded-2lg bg-background-inner-default p-2.5 shadow-card sm:flex-1"
          >
            <p className="w-full truncate text-body-medium text-text-primary">{stat.value}</p>
            <p className="w-full truncate text-body-medium text-text-secondary">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Activity */}
      <div className="-mt-2 flex min-h-0 w-full flex-1 flex-col gap-1">
        <div className="flex w-full items-center justify-between">
          <p className="text-body-medium text-text-secondary">Activity</p>
          <SegmentedControl
            variant="plain"
            selectedKeys={[period]}
            onSelectionChange={(keys) => {
              const next = [...(keys as Set<string>)][0];
              if (next) setPeriod(next);
            }}
            aria-label="Activity period"
          >
            <SegmentedControlItem id="weekly">Weekly</SegmentedControlItem>
            <SegmentedControlItem id="monthly">Monthly</SegmentedControlItem>
            <SegmentedControlItem id="yearly">Yearly</SegmentedControlItem>
          </SegmentedControl>
        </div>

        <div className="flex min-h-0 w-full flex-1 flex-col gap-1.5 overflow-x-auto sm:overflow-visible">
          {/* Mobile: fixed 13px square cells that overflow into horizontal
              scroll instead of squishing thin. From sm, columns go back to
              flexible 1fr tracks that stretch to fill the card width —
              `aspect-square` keeps every cell square as it grows, instead of
              the old fixed 13px height that left empty space on wide cards. */}
          <div className="flex w-max flex-col gap-1.5 sm:w-full">
            <ContributionsGrid columns={GRID_COLUMNS} accent={accent} />
            <div className="flex w-full justify-between text-body-2-medium text-text-tertiary">
              {MONTHS.map((month) => (
                <span key={month}>{month}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
