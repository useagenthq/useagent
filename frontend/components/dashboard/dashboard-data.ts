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
  const status = toRunStatus(r.status);
  if (!status) return null;
  return {
    id: r.id,
    prompt: typeof r.prompt === 'string' ? r.prompt : '',
    model: typeof r.model === 'string' ? r.model : null,
    engine: typeof r.engine === 'string' ? r.engine : null,
    repo: primaryRepo(r),
    status,
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

/* ---------------------------------------------------------------------------
 * Analytics band aggregates — plain JSON derived server-side and handed to the
 * client AnalyticsBand (format functions cannot cross the RSC boundary, data
 * can). Every number is a real count off the runs snapshot; no demo values.
 */

/** Monday 00:00 local of the week containing `ms`. */
function mondayOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - ((d.getDay() + 6) % 7) * DAY_MS;
}

/** Index signature matches the chart cards' `{label} & Record<string, ...>` rows. */
export interface WeekComboPoint {
  [key: string]: number | string;
  label: string;
  runs: number;
}

export interface DashboardSummary {
  stats: RunStats;
  counts: { skills: number; knowledge: number };
  daily: DayBucket[];
  weekly: WeekComboPoint[];
  settlementHistoryFrom: string | null;
  timezone: "UTC";
}

/** Decode the authoritative dashboard aggregate response. Invalid data stays
 * unavailable instead of becoming a plausible-looking zero. */
export function extractDashboardSummary(data: unknown): DashboardSummary | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  const stats = value.stats as Record<string, unknown> | undefined;
  const counts = value.counts as Record<string, unknown> | undefined;
  if (!stats || !counts || !Array.isArray(value.daily) || !Array.isArray(value.weekly)) return null;
  const number = (input: unknown): number | null =>
    typeof input === "number" && Number.isFinite(input) ? input : null;
  const total = number(stats.total);
  const running = number(stats.running);
  const queued = number(stats.queued);
  const completed = number(stats.completed);
  const failed = number(stats.failed);
  const completedToday = number(stats.completed_today);
  const skills = number(counts.skills);
  const knowledge = number(counts.knowledge);
  if (
    total === null || running === null || queued === null || completed === null ||
    failed === null || completedToday === null || skills === null || knowledge === null
  ) return null;
  return {
    stats: { total, running, queued, completed, failed, completedToday },
    counts: { skills, knowledge },
    daily: value.daily as DayBucket[],
    weekly: value.weekly as WeekComboPoint[],
    settlementHistoryFrom:
      typeof value.settlement_history_from === "string" ? value.settlement_history_from : null,
    timezone: "UTC",
  };
}

/** Monday-anchored week buckets, oldest → newest, for the weekly bar card. */
export function weeklyCombo(
  runs: readonly DashRun[],
  weeks = 8,
  now: number = Date.now(),
): WeekComboPoint[] {
  const fmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
  const thisMonday = mondayOf(now);
  const buckets = Array.from({ length: weeks }, (_, i) => ({
    label: fmt.format(thisMonday - (weeks - 1 - i) * 7 * DAY_MS),
    runs: 0,
  }));
  for (const run of runs) {
    const ts = timestamp(run.created_at);
    if (!ts) continue;
    const idx = weeks - 1 - Math.round((thisMonday - mondayOf(ts)) / (7 * DAY_MS));
    const bucket = buckets[idx];
    if (!bucket) continue;
    bucket.runs += 1;
  }
  return buckets;
}
