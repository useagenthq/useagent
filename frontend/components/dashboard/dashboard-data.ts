/**
 * Pure helpers + types for the /dashboard overview. No React, no "use client" —
 * safe to import from the server page (SSR fetch) and the client chart cards
 * alike, so the derived numbers stay identical on both sides.
 *
 * The backend list endpoints ship envelopes: `{ runs: [...] }`, `{ skills: [...] }`,
 * `{ records: [...] }`. Every extractor tolerates a bare array too and normalises
 * defensively so a shape drift never crashes the dashboard.
 */

import { envelope, primaryRepo, toRunStatus, type RunStatus } from '@/lib/runs';

export type { RunStatus };

/** The slim run shape the dashboard needs (steps/trace are irrelevant here). */
export interface DashRun {
  id: string;
  prompt: string;
  model: string | null;
  engine: string | null;
  /** Primary repository for this run, using the authoritative wire fallback order. */
  repo: string | null;
  status: RunStatus;
  duration_ms: number | null;
  created_at: string | number;
}

export function extractRuns(data: unknown): DashRun[] {
  return envelope(data, 'runs')
    .map(toDashRun)
    .filter((r): r is DashRun => r !== null);
}

function toDashRun(value: unknown): DashRun | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    prompt: typeof r.prompt === 'string' ? r.prompt : '',
    model: typeof r.model === 'string' ? r.model : null,
    engine: typeof r.engine === 'string' ? r.engine : null,
    repo: primaryRepo(r),
    status: toRunStatus(r.status),
    duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null,
    created_at: (r.created_at as string | number) ?? 0,
  };
}

/** Count items inside a `{ [key]: [...] }` envelope (skills, knowledge records). */
export function extractCount(data: unknown, key: string): number {
  return envelope(data, key).length;
}

export interface RunStats {
  total: number;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  completedToday: number;
}

export function computeStats(runs: readonly DashRun[]): RunStats {
  const stats: RunStats = {
    total: runs.length,
    running: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    completedToday: 0,
  };
  const today = dayKey(Date.now());
  for (const run of runs) {
    if (run.status === 'running') stats.running += 1;
    else if (run.status === 'queued') stats.queued += 1;
    else if (run.status === 'completed') stats.completed += 1;
    else if (run.status === 'failed') stats.failed += 1;
    if (run.status === 'completed' && dayKey(timestamp(run.created_at)) === today) {
      stats.completedToday += 1;
    }
  }
  return stats;
}

/** Millisecond timestamp of a run `created_at` (string or epoch; 0 on junk). */
export function timestamp(value: string | number): number {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

/** Newest runs sent to the interactive table; bounds the RSC client payload. */
export function recentRuns(runs: readonly DashRun[], limit = 80): DashRun[] {
  return runs.toSorted((a, b) => timestamp(b.created_at) - timestamp(a.created_at)).slice(0, limit);
}

/** Local YYYY-MM-DD key for a timestamp (0 => empty, sorts before all days). */
function dayKey(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;

export interface DayBucket {
  key: string;
  /** Short weekday label, e.g. "Mon". */
  label: string;
  total: number;
  completed: number;
  failed: number;
}

/**
 * Bucket runs into the last `days` calendar days (oldest → newest), anchored on
 * `now`. Used by the bar chart (completed vs failed stack) and the trend line.
 */
export function runsPerDay(
  runs: readonly DashRun[],
  days: number,
  now: number = Date.now(),
): DayBucket[] {
  const weekday = new Intl.DateTimeFormat('en', { weekday: 'short' });
  const buckets = new Map<string, DayBucket>();
  const order: string[] = [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(start.getTime() - i * DAY_MS);
    const key = dayKey(d.getTime());
    order.push(key);
    buckets.set(key, {
      key,
      label: weekday.format(d),
      total: 0,
      completed: 0,
      failed: 0,
    });
  }
  for (const run of runs) {
    const bucket = buckets.get(dayKey(timestamp(run.created_at)));
    if (!bucket) continue;
    bucket.total += 1;
    if (run.status === 'completed') bucket.completed += 1;
    else if (run.status === 'failed') bucket.failed += 1;
  }
  return order.map((key) => buckets.get(key)!);
}

export interface HeatCell {
  key: string;
  count: number;
  /** 0–4 intensity level for the contributions grid. */
  level: 0 | 1 | 2 | 3 | 4;
}

/**
 * GitHub-style contributions grid: `weeks` columns × 7 rows (Sun→Sat),
 * newest week last. Intensity is bucketed against the busiest day so a light
 * dataset still shows contrast.
 */
export function buildHeatmap(
  runs: readonly DashRun[],
  weeks: number,
  now: number = Date.now(),
): { cells: HeatCell[][]; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const run of runs) {
    const key = dayKey(timestamp(run.created_at));
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }

  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  // Walk back to the Sunday that starts the grid.
  const gridEnd = end.getTime() - end.getDay() * DAY_MS + 6 * DAY_MS;
  const max = Math.max(1, ...counts.values());

  const columns: HeatCell[][] = [];
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const column: HeatCell[] = [];
    for (let d = 0; d < 7; d += 1) {
      const ms = gridEnd - (w * 7 + (6 - d)) * DAY_MS;
      const key = dayKey(ms);
      const count = ms > now ? 0 : counts.get(key) ?? 0;
      column.push({ key, count, level: level(count, max) });
    }
    columns.push(column);
  }
  return { cells: columns, total };
}

function level(count: number, max: number): HeatCell['level'] {
  if (count <= 0) return 0;
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}
