"use client";

import { useState } from "react";
import {
  RiLinksLine,
  RiPriceTag3Line,
  RiPulseLine,
  RiTimeLine,
} from "@remixicon/react";
import * as Checkbox from "@/components/ui/checkbox";
import { cx } from "@/utils/cx";

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
  neutral: "bg-foreground-icon-tertiary",
};

export type StrengthTone = "critical" | "weak" | "neutral" | "strong";

const strengthDot: Record<StrengthTone, string> = {
  critical: "bg-red-500",
  weak: "bg-yellow-500",
  neutral: "bg-foreground-icon-tertiary",
  strong: "bg-lime-500",
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

const STICKY = "sticky left-0 z-10 bg-background-primary-default group-hover/row:bg-background-primary-hover";

function HeaderIcon({ as: Icon }: { as: typeof RiTimeLine }) {
  return <Icon className="text-text-tertiary size-3.5 shrink-0" aria-hidden />;
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
      className={cx(
        "border-border-button-default bg-background-primary-default shadow-sm overflow-x-auto rounded-xl border",
        className,
      )}
    >
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-border-button-default border-b">
            <th
              className={cx(
                STICKY,
                "bg-background-primary-default text-caption-1-medium text-text-tertiary px-3 py-2 font-medium",
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
            <th className="text-caption-1-medium text-text-tertiary px-3 py-2 font-medium">
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiPriceTag3Line} />
                Categories
              </span>
            </th>
            <th className="text-caption-1-medium text-text-tertiary px-3 py-2 font-medium">
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiTimeLine} />
                Last interaction
              </span>
            </th>
            <th className="text-caption-1-medium text-text-tertiary px-3 py-2 font-medium">
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiPulseLine} />
                Connection strength
              </span>
            </th>
            <th className="text-caption-1-medium text-text-tertiary px-3 py-2 font-medium">
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
              className="group/row border-border-button-default hover:bg-background-primary-hover border-b transition-colors duration-100 last:border-0"
            >
              <td className={cx(STICKY, "px-3 py-2.5")}>
                <div className="flex items-center gap-2.5">
                  <Checkbox.Root
                    checked={selected.has(ri)}
                    onCheckedChange={(v) => toggle(ri, v === true)}
                  />
                  <span
                    aria-hidden
                    className="bg-background-tertiary-default text-text-secondary flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold"
                  >
                    {row.company.charAt(0).toUpperCase()}
                  </span>
                  <span className="text-body-2-medium text-text-primary whitespace-nowrap">
                    {row.company}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2.5">
                <div className="flex flex-wrap gap-1">
                  {(row.categories ?? []).map((tag) => (
                    <span
                      key={tag.label}
                      className="bg-background-secondary-default text-text-secondary inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] font-medium"
                    >
                      <span
                        className={cx(
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
              <td className="text-text-secondary whitespace-nowrap px-3 py-2.5 text-caption-1-regular">
                {row.lastInteraction ?? "-"}
              </td>
              <td className="px-3 py-2.5">
                {row.strength ? (
                  <span className="text-text-secondary inline-flex items-center gap-1.5 whitespace-nowrap text-caption-1-regular">
                    <span
                      className={cx(
                        "size-1.5 rounded-full",
                        strengthDot[row.strength.tone],
                      )}
                      aria-hidden
                    />
                    {row.strength.label}
                  </span>
                ) : (
                  <span className="text-text-tertiary">-</span>
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
                          className="text-text-secondary hover:text-text-primary whitespace-nowrap text-caption-1-regular underline underline-offset-2 transition-colors"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <span
                          key={link.label}
                          className="text-text-secondary whitespace-nowrap text-caption-1-regular"
                        >
                          {link.label}
                        </span>
                      ),
                    )}
                  </div>
                ) : (
                  <span className="text-text-tertiary">-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
