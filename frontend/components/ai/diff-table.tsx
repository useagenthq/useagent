import * as Badge from "@/components/ui/badge";
import { cnExt as cn } from "@/utils/cn";

/**
 * Proposed-changes table — a compact bordered diff. Ported from the AI
 * library's DiffTable onto AlignUI tokens.
 *
 * Each row carries an optional `status` that tints its left edge and reads:
 *   added   → success edge + soft success row, leading "+"
 *   removed → error edge + soft error row, leading "−", struck-through
 *   changed → away (amber) edge; the changed value cells render as small badges
 *
 * Presentational only — safe to drop into any surface.
 */

type DiffStatus = "added" | "removed" | "changed";

export interface DiffRow {
  cells: string[];
  status?: DiffStatus;
}

export interface DiffTableProps {
  columns: string[];
  rows: DiffRow[];
  className?: string;
}

const statusMeta: Record<
  DiffStatus,
  { edge: string; rowTint: string; text: string; sign: string }
> = {
  added: {
    edge: "hsl(var(--success-base))",
    rowTint: "bg-success-lighter",
    text: "text-success-base",
    sign: "+",
  },
  removed: {
    edge: "hsl(var(--error-base))",
    rowTint: "bg-error-lighter",
    text: "text-error-base line-through",
    sign: "−",
  },
  changed: {
    edge: "hsl(var(--away-base))",
    rowTint: "",
    text: "",
    sign: "",
  },
};

export function DiffTable({ columns, rows, className }: DiffTableProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs",
        className,
      )}
    >
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-stroke-soft-200">
            {columns.map((col) => (
              <th
                key={col}
                className="px-3 py-2 text-label-xs font-medium text-text-soft-400"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const meta = row.status ? statusMeta[row.status] : null;
            const isChanged = row.status === "changed";
            return (
              <tr
                // Rows are a static ordered list; index keys are stable.
                key={ri}
                className={cn(
                  "border-b border-stroke-soft-200 last:border-0",
                  meta?.rowTint,
                )}
              >
                {row.cells.map((cell, ci) => {
                  const asBadge = isChanged && ci > 0;
                  const tinted = meta && !isChanged ? meta.text : "";
                  return (
                    <td
                      key={ci}
                      className={cn(
                        "px-3 py-2 align-middle text-paragraph-xs",
                        ci === 0 && "border-l-2 font-medium",
                        tinted ||
                          (ci === 0
                            ? "text-text-strong-950"
                            : "text-text-sub-600"),
                      )}
                      style={
                        ci === 0
                          ? { borderLeftColor: meta ? meta.edge : "transparent" }
                          : undefined
                      }
                    >
                      {asBadge ? (
                        <Badge.Root variant="light" color="yellow" size="medium">
                          {cell}
                        </Badge.Root>
                      ) : (
                        <>
                          {meta?.sign && ci === 0 ? `${meta.sign} ` : ""}
                          {cell}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
