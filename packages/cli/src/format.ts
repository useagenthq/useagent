// Pure formatting for the `fan` summary. Deterministic string in, string out - so the
// table is unit-testable and never touches process IO.

import type { FanResultLine } from "./jsonl";

function countBy(results: readonly FanResultLine[], key: (r: FanResultLine) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  return counts;
}

function renderCounts(counts: Map<string, number>): string {
  return [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(", ");
}

/** A compact aligned table (RUN / STATUS / VERDICT) plus totals-by-status and, when any
 *  QC ran, totals-by-verdict. Pure and deterministic. */
export function formatFanSummary(results: readonly FanResultLine[]): string {
  const rows = results.map((r) => ({
    run: r.runId ?? "-",
    status: r.status,
    verdict: r.verdict ?? "-",
  }));
  const headers = { run: "RUN", status: "STATUS", verdict: "VERDICT" } as const;
  const widthOf = (key: keyof typeof headers): number =>
    Math.max(headers[key].length, ...rows.map((r) => r[key].length));
  const w = { run: widthOf("run"), status: widthOf("status"), verdict: widthOf("verdict") };
  const pad = (value: string, width: number): string => value.padEnd(width);
  const line = (cells: { run: string; status: string; verdict: string }): string =>
    `${pad(cells.run, w.run)}  ${pad(cells.status, w.status)}  ${pad(cells.verdict, w.verdict)}`.trimEnd();

  const body = [line(headers), ...rows.map(line)].join("\n");
  const totals = `${results.length} task(s): ${renderCounts(countBy(results, (r) => r.status))}`;
  const verdicts = results.some((r) => r.verdict !== undefined)
    ? `\nverdicts: ${renderCounts(countBy(results.filter((r) => r.verdict !== undefined), (r) => r.verdict ?? "-"))}`
    : "";
  return `${body}\n\n${totals}${verdicts}`;
}
