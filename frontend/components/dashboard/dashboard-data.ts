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
  /** % of settled runs (completed+failed) that completed; 0 on idle weeks. */
  success: number;
}

/** Monday-anchored week buckets, oldest → newest, for the combo card. */
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
    completed: 0,
    failed: 0,
  }));
  for (const run of runs) {
    const ts = timestamp(run.created_at);
    if (!ts) continue;
    const idx = weeks - 1 - Math.round((thisMonday - mondayOf(ts)) / (7 * DAY_MS));
    const bucket = buckets[idx];
    if (!bucket) continue;
    bucket.runs += 1;
    if (run.status === 'completed') bucket.completed += 1;
    else if (run.status === 'failed') bucket.failed += 1;
  }
  return buckets.map(({ label, runs: total, completed, failed }) => ({
    label,
    runs: total,
    success: completed + failed > 0 ? Math.round((100 * completed) / (completed + failed)) : 0,
  }));
}

export interface StatusSlice {
  label: string;
  value: number;
  color?: string;
  activeColor?: string;
}

/** Status mix for the radial rings — ascending so the rings nest correctly. */
export function statusSlices(stats: RunStats): StatusSlice[] {
  const slices: StatusSlice[] = [
    { label: 'Queued', value: stats.queued, color: 'var(--color-chart-5)', activeColor: 'var(--color-chart-5-active)' },
    { label: 'Running', value: stats.running, color: 'var(--color-chart-6)', activeColor: 'var(--color-chart-6-active)' },
    { label: 'Failed', value: stats.failed, color: 'var(--color-red-500)', activeColor: 'var(--color-red-600)' },
    { label: 'Completed', value: stats.completed, color: 'var(--color-chart-7)', activeColor: 'var(--color-chart-7-active)' },
  ];
  return slices.filter((s) => s.value > 0).toSorted((a, b) => a.value - b.value);
}

export interface FlowNode {
  name: string;
  color?: string;
  activeColor?: string;
}
export interface FlowLink {
  source: number;
  target: number;
  value: number;
}
export interface EngineFlow {
  nodes: FlowNode[];
  links: FlowLink[];
}

const STATUS_LABEL: Record<RunStatus, string> = {
  completed: 'Completed',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
};
const FLOW_TONES = [4, 7, 5, 8, 3] as const;

/**
 * Engine → outcome ribbons for the Sankey card: top engines by volume as
 * coloured sources, outcome statuses as neutral sinks. Sinks with no inbound
 * ribbon are dropped (Recharts rejects orphan nodes).
 */
export function engineFlow(runs: readonly DashRun[], maxEngines = 5): EngineFlow {
  const engineTotals = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const run of runs) {
    const engine = run.engine ?? 'unknown';
    engineTotals.set(engine, (engineTotals.get(engine) ?? 0) + 1);
    const key = `${engine} ${run.status}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const engines = [...engineTotals.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, maxEngines)
    .map(([name]) => name);
  const statuses = (Object.keys(STATUS_LABEL) as RunStatus[]).filter((status) =>
    engines.some((engine) => (pairs.get(`${engine} ${status}`) ?? 0) > 0),
  );
  const nodes: FlowNode[] = [
    ...engines.map((name, i) => {
      const tone = FLOW_TONES[i % FLOW_TONES.length];
      return {
        name,
        color: `var(--color-chart-${tone})`,
        activeColor: `var(--color-chart-${tone}-active)`,
      };
    }),
    ...statuses.map((status) => ({ name: STATUS_LABEL[status] })),
  ];
  const links: FlowLink[] = [];
  engines.forEach((engine, ei) => {
    statuses.forEach((status, si) => {
      const value = pairs.get(`${engine} ${status}`) ?? 0;
      if (value > 0) links.push({ source: ei, target: engines.length + si, value });
    });
  });
  return { nodes, links };
}

export interface ScatterPointData {
  x: number;
  y: number;
  label?: string;
}
export interface ScatterSeriesData {
  label: string;
  points: ScatterPointData[];
  color?: string;
  activeColor?: string;
}

/** Settled-run durations by local hour of day: one dot per run, newest first. */
export function durationScatter(
  runs: readonly DashRun[],
  days = 14,
  cap = 150,
  now: number = Date.now(),
): ScatterSeriesData[] {
  const cutoff = now - days * DAY_MS;
  const completed: ScatterPointData[] = [];
  const failed: ScatterPointData[] = [];
  for (const run of recentRuns(runs, runs.length)) {
    if (run.duration_ms == null || run.duration_ms <= 0) continue;
    if (run.status !== 'completed' && run.status !== 'failed') continue;
    const ts = timestamp(run.created_at);
    if (ts < cutoff) continue;
    const bucket = run.status === 'completed' ? completed : failed;
    if (bucket.length >= cap) continue;
    const d = new Date(ts);
    bucket.push({
      x: Math.round((d.getHours() + d.getMinutes() / 60) * 10) / 10,
      y: Math.max(0.1, Math.round(run.duration_ms / 6000) / 10),
      label: run.prompt ? run.prompt.slice(0, 48) : run.id.slice(0, 8),
    });
  }
  const series: ScatterSeriesData[] = [];
  if (completed.length > 0)
    series.push({
      label: 'Completed',
      points: completed,
      color: 'var(--color-chart-7)',
      activeColor: 'var(--color-chart-7-active)',
    });
  if (failed.length > 0)
    series.push({
      label: 'Failed',
      points: failed,
      color: 'var(--color-red-500)',
      activeColor: 'var(--color-red-600)',
    });
  return series;
}

/** Run counts by repository, top `limit`; repo-less runs grouped together. */
export function repoLeaders(
  runs: readonly DashRun[],
  limit = 7,
): { label: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const label = run.repo ?? 'No repository';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

export interface WeekdayPoint {
  [key: string]: number | string;
  label: string;
  current: number;
  previous: number;
}

/** Mon→Sun run counts, this week vs last, for the radar card. */
export function weekdayRadar(runs: readonly DashRun[], now: number = Date.now()): WeekdayPoint[] {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const currentMonday = mondayOf(now);
  const previousMonday = currentMonday - 7 * DAY_MS;
  const points = labels.map((label) => ({ label, current: 0, previous: 0 }));
  for (const run of runs) {
    const ts = timestamp(run.created_at);
    if (!ts) continue;
    const week = mondayOf(ts);
    if (week !== currentMonday && week !== previousMonday) continue;
    const point = points[Math.floor((ts - week) / DAY_MS)];
    if (!point) continue;
    if (week === currentMonday) point.current += 1;
    else point.previous += 1;
  }
  return points;
}
