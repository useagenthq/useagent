"use client";

import { useMemo, useState } from "react";
import { cx } from "@/utils/cx";

/**
 * Status-filtered task table — a row of filter chips (each with a live count)
 * over a compact table whose status cell renders a tone-colored pill. Selecting
 * a chip filters the rows. Ported from the beautiful-ui FilterTable demo
 * (hardcoded → parameterized) onto our tokens.
 */

export type FilterTone =
  | "warning"
  | "information"
  | "success"
  | "error"
  | "away"
  | "neutral";

const tone: Record<FilterTone, { dot: string; pill: string }> = {
  warning: { dot: "bg-yellow-500", pill: "bg-status-yellow-background text-status-yellow-text" },
  information: {
    dot: "bg-blue-500",
    pill: "bg-status-blue-background text-status-blue-text",
  },
  success: { dot: "bg-lime-500", pill: "bg-status-lime-background text-status-lime-text" },
  error: { dot: "bg-red-500", pill: "bg-status-rose-background text-status-rose-text" },
  away: { dot: "bg-orange-500", pill: "bg-orange-100 text-orange-700" },
  neutral: { dot: "bg-foreground-icon-tertiary", pill: "bg-background-secondary-default text-text-secondary" },
};

export interface FilterStatus {
  /** Stable key referenced by each row's `statusKey`. */
  key: string;
  label: string;
  tone: FilterTone;
}

export interface FilterRow {
  name: string;
  date: string;
  statusKey: string;
  advisor: string;
}

export interface FilterTableProps {
  statuses: FilterStatus[];
  rows: FilterRow[];
  /** Column header labels; sensible defaults provided. */
  headers?: { name?: string; date?: string; status?: string; advisor?: string };
  className?: string;
}

const COLS = "grid grid-cols-[1.3fr_0.6fr_0.95fr_0.9fr]";

export function FilterTable({
  statuses,
  rows,
  headers,
  className,
}: FilterTableProps) {
  const [active, setActive] = useState<string>("all");

  const byKey = useMemo(
    () => new Map(statuses.map((s) => [s.key, s])),
    [statuses],
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows)
      map.set(row.statusKey, (map.get(row.statusKey) ?? 0) + 1);
    return map;
  }, [rows]);

  const shown = active === "all" ? rows : rows.filter((r) => r.statusKey === active);

  const h = {
    name: headers?.name ?? "Task name",
    date: headers?.date ?? "Date",
    status: headers?.status ?? "Status",
    advisor: headers?.advisor ?? "Advisor",
  };

  function Chip({
    id,
    label,
    count,
    dot,
  }: {
    id: string;
    label: string;
    count: number;
    dot?: string;
  }) {
    const on = active === id;
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => setActive(id)}
        className={cx(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-caption-1-medium transition-colors duration-200",
          on
            ? "bg-background-primary-default text-text-primary shadow-sm ring-border-button-default ring-1"
            : "text-text-secondary hover:bg-background-primary-hover",
        )}
      >
        {dot && <span className={cx("size-1.5 rounded-full", dot)} aria-hidden />}
        {label}
        <span
          className={cx(
            "rounded px-1 text-[10.5px] tabular-nums",
            on ? "bg-background-secondary-default text-text-secondary" : "text-text-tertiary",
          )}
        >
          {count}
        </span>
      </button>
    );
  }

  return (
    <div className={cx("w-full", className)}>
      <div className="mb-1 flex items-center gap-1 overflow-x-auto py-1">
        <Chip id="all" label="All" count={rows.length} />
        {statuses.map((s) => (
          <Chip
            key={s.key}
            id={s.key}
            label={s.label}
            count={counts.get(s.key) ?? 0}
            dot={tone[s.tone].dot}
          />
        ))}
      </div>

      <div className="border-border-button-default bg-background-primary-default shadow-sm overflow-x-auto rounded-xl border">
        <div className="min-w-[420px]">
          <div
            className={cx(
              COLS,
              "border-border-button-default text-caption-1-medium text-text-tertiary border-b px-3 py-2",
            )}
          >
            <span>{h.name}</span>
            <span>{h.date}</span>
            <span>{h.status}</span>
            <span>{h.advisor}</span>
          </div>
          {shown.map((row, i) => {
            const status = byKey.get(row.statusKey);
            return (
              <div
                key={`${row.name}-${i}`}
                className={cx(
                  COLS,
                  "border-border-button-default hover:bg-background-primary-hover items-center border-b px-3 py-2 text-caption-1-regular transition-colors duration-100 last:border-0",
                )}
              >
                <span className="text-text-primary truncate font-medium">
                  {row.name}
                </span>
                <span className="text-text-secondary tabular-nums">{row.date}</span>
                <span>
                  {status && (
                    <span
                      className={cx(
                        "inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium",
                        tone[status.tone].pill,
                      )}
                    >
                      {status.label}
                    </span>
                  )}
                </span>
                <span className="text-text-secondary truncate">{row.advisor}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
