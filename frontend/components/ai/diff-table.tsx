import * as Badge from "@/components/ui/badge";
import { cx } from "@/utils/cx";

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
    edge: "var(--color-lime-500)",
    rowTint: "bg-status-lime-background",
    text: "text-lime-600",
    sign: "+",
  },
  removed: {
    edge: "var(--color-red-500)",
    rowTint: "bg-status-rose-background",
    text: "text-text-error-primary line-through",
    sign: "−",
  },
  changed: {
    edge: "var(--color-orange-500)",
    rowTint: "",
    text: "",
    sign: "",
  },
};

export function DiffTable({ columns, rows, className }: DiffTableProps) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default shadow-card",
        className,
      )}
    >
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border-button-default">
            {columns.map((col) => (
              <th
                key={col}
                className="px-3 py-2 text-caption-1-medium font-medium text-text-tertiary"
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
                className={cx(
                  "border-b border-border-button-default last:border-0",
                  meta?.rowTint,
                )}
              >
                {row.cells.map((cell, ci) => {
                  const asBadge = isChanged && ci > 0;
                  const tinted = meta && !isChanged ? meta.text : "";
                  return (
                    <td
                      key={ci}
                      className={cx(
                        "px-3 py-2 align-middle text-caption-1-regular",
                        ci === 0 && "border-l-2 font-medium",
                        tinted ||
                          (ci === 0
                            ? "text-text-primary"
                            : "text-text-secondary"),
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
