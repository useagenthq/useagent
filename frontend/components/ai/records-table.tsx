"use client";

import { useState } from "react";
import {
  RiLinksLine,
  RiPriceTag3Line,
  RiPulseLine,
  RiTimeLine,
} from "@remixicon/react";
import * as Checkbox from "@/components/ui/checkbox";
import { cnExt as cn } from "@/utils/cn";

/**
 * Tag-heavy records table — a horizontally scrollable companies grid with a
 * sticky first column (select checkbox + letter mark + name), colored category
 * tags, a relative last-interaction, a tone-colored connection-strength dot, and
 * a links cell. Ported from the beautiful-ui RecordsTable demo (hardcoded →
 * parameterized) onto AlignUI tokens.
 */

export type RecordTagColor =
  | "purple"
  | "pink"
  | "blue"
  | "green"
  | "orange"
  | "teal"
  | "sky"
  | "yellow"
  | "red"
  | "neutral";

const tagDot: Record<RecordTagColor, string> = {
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  blue: "bg-blue-500",
  green: "bg-green-500",
  orange: "bg-orange-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
  neutral: "bg-text-soft-400",
};

export type StrengthTone = "critical" | "weak" | "neutral" | "strong";

const strengthDot: Record<StrengthTone, string> = {
  critical: "bg-error-base",
  weak: "bg-warning-base",
  neutral: "bg-text-soft-400",
  strong: "bg-success-base",
};

export interface RecordTag {
  label: string;
  color?: RecordTagColor;
}

export interface RecordRow {
  company: string;
  categories?: RecordTag[];
  lastInteraction?: string;
  strength?: { label: string; tone: StrengthTone };
  links?: { label: string; href?: string }[];
}

export interface RecordsTableProps {
  rows: RecordRow[];
  className?: string;
}

const STICKY = "sticky left-0 z-10 bg-bg-white-0 group-hover/row:bg-bg-weak-50";

function HeaderIcon({ as: Icon }: { as: typeof RiTimeLine }) {
  return <Icon className="text-text-soft-400 size-3.5 shrink-0" aria-hidden />;
}

export function RecordsTable({ rows, className }: RecordsTableProps) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggle(index: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelected(on ? new Set(rows.map((_, i) => i)) : new Set());
  }

  return (
    <div
      className={cn(
        "border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm overflow-x-auto rounded-xl border",
        className,
      )}
    >
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-stroke-soft-200 border-b">
            <th
              className={cn(
                STICKY,
                "bg-bg-white-0 text-label-xs text-text-soft-400 px-3 py-2 font-medium",
              )}
            >
              <div className="flex items-center gap-2.5">
                <Checkbox.Root
                  checked={allSelected}
                  onCheckedChange={(v) => toggleAll(v === true)}
                />
                <span>Company</span>
              </div>
            </th>
            <th className="text-label-xs text-text-soft-400 px-3 py-2 font-medium">
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiPriceTag3Line} />
                Categories
              </span>
            </th>
            <th className="text-label-xs text-text-soft-400 px-3 py-2 font-medium">
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiTimeLine} />
                Last interaction
              </span>
            </th>
            <th className="text-label-xs text-text-soft-400 px-3 py-2 font-medium">
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiPulseLine} />
                Connection strength
              </span>
            </th>
            <th className="text-label-xs text-text-soft-400 px-3 py-2 font-medium">
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiLinksLine} />
                Links
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={`${row.company}-${ri}`}
              className="group/row border-stroke-soft-200 hover:bg-bg-weak-50 border-b transition-colors duration-100 last:border-0"
            >
              <td className={cn(STICKY, "px-3 py-2.5")}>
                <div className="flex items-center gap-2.5">
                  <Checkbox.Root
                    checked={selected.has(ri)}
                    onCheckedChange={(v) => toggle(ri, v === true)}
                  />
                  <span
                    aria-hidden
                    className="bg-bg-soft-200 text-text-sub-600 flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold"
                  >
                    {row.company.charAt(0).toUpperCase()}
                  </span>
                  <span className="text-label-sm text-text-strong-950 whitespace-nowrap">
                    {row.company}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <div className="flex flex-wrap gap-1">
                  {(row.categories ?? []).map((tag) => (
                    <span
                      key={tag.label}
                      className="bg-bg-weak-50 text-text-sub-600 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] font-medium"
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          tagDot[tag.color ?? "neutral"],
                        )}
                        aria-hidden
                      />
                      {tag.label}
                    </span>
                  ))}
                </div>
              </td>
              <td className="text-text-sub-600 whitespace-nowrap px-3 py-2.5 text-paragraph-xs">
                {row.lastInteraction ?? "—"}
              </td>
              <td className="px-3 py-2.5">
                {row.strength ? (
                  <span className="text-text-sub-600 inline-flex items-center gap-1.5 whitespace-nowrap text-paragraph-xs">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        strengthDot[row.strength.tone],
                      )}
                      aria-hidden
                    />
                    {row.strength.label}
                  </span>
                ) : (
                  <span className="text-text-soft-400">—</span>
                )}
              </td>
              <td className="px-3 py-2.5">
                {row.links && row.links.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {row.links.map((link) =>
                      link.href ? (
                        <a
                          key={link.label}
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-text-sub-600 hover:text-text-strong-950 whitespace-nowrap text-paragraph-xs underline underline-offset-2 transition-colors"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <span
                          key={link.label}
                          className="text-text-sub-600 whitespace-nowrap text-paragraph-xs"
                        >
                          {link.label}
                        </span>
                      ),
                    )}
                  </div>
                ) : (
                  <span className="text-text-soft-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
