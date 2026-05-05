"use client";

import { useMemo, useState } from "react";
import { cnExt as cn } from "@/utils/cn";

/**
 * Status-filtered task table — a row of filter chips (each with a live count)
 * over a compact table whose status cell renders a tone-colored pill. Selecting
 * a chip filters the rows. Ported from the beautiful-ui FilterTable demo
 * (hardcoded → parameterized) onto AlignUI tokens.
 */

export type FilterTone =
  | "warning"
  | "information"
  | "success"
  | "error"
  | "away"
  | "neutral";

const tone: Record<FilterTone, { dot: string; pill: string }> = {
  warning: { dot: "bg-warning-base", pill: "bg-warning-lighter text-warning-base" },
  information: {
    dot: "bg-information-base",
    pill: "bg-information-lighter text-information-base",
  },
  success: { dot: "bg-success-base", pill: "bg-success-lighter text-success-base" },
  error: { dot: "bg-error-base", pill: "bg-error-lighter text-error-base" },
  away: { dot: "bg-away-base", pill: "bg-away-lighter text-away-base" },
  neutral: { dot: "bg-text-soft-400", pill: "bg-bg-weak-50 text-text-sub-600" },
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
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-label-xs transition-colors duration-200",
          on
            ? "bg-bg-white-0 text-text-strong-950 shadow-regular-sm ring-stroke-soft-200 ring-1"
            : "text-text-sub-600 hover:bg-bg-weak-50",
        )}
      >
        {dot && <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />}
        {label}
        <span
          className={cn(
            "rounded px-1 text-[10.5px] tabular-nums",
            on ? "bg-bg-weak-50 text-text-sub-600" : "text-text-soft-400",
          )}
        >
          {count}
        </span>
      </button>
    );
  }

  return (
    <div className={cn("w-full", className)}>
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

      <div className="border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm overflow-x-auto rounded-xl border">
        <div className="min-w-[420px]">
          <div
            className={cn(
              COLS,
              "border-stroke-soft-200 text-label-xs text-text-soft-400 border-b px-3 py-2",
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
                className={cn(
                  COLS,
                  "border-stroke-soft-200 hover:bg-bg-weak-50 items-center border-b px-3 py-2 text-paragraph-xs transition-colors duration-100 last:border-0",
                )}
              >
                <span className="text-text-strong-950 truncate font-medium">
                  {row.name}
                </span>
                <span className="text-text-sub-600 tabular-nums">{row.date}</span>
                <span>
                  {status && (
                    <span
                      className={cn(
                        "inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium",
                        tone[status.tone].pill,
                      )}
                    >
                      {status.label}
                    </span>
                  )}
                </span>
                <span className="text-text-sub-600 truncate">{row.advisor}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
