/**
 * Presentational formatters shared across surfaces (dashboard, workspace fleet,
 * runs list, knowledge). Pure and isomorphic — safe on server and client.
 */

/** Coarse run duration: "-" / "8s" / "2m 05s" (rounded to whole seconds). */
export function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "-";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, "0")}s`;
}

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact number: 12480 → "12.5K", 1_200_000 → "1.2M". */
export function compactNumber(n: number): string {
  return compact.format(n);
}

/** Rough per-run token cost for the clearly-estimated "tokens" headline. */
export const TOKENS_PER_RUN = 48_500;

/** "≈ tokens" headline derived purely from run count — labelled estimated in UI. */
export function estimatedTokens(runCount: number): string {
  return compact.format(runCount * TOKENS_PER_RUN);
}

/** Older than this and a relative label stops helping, so the local date is shown instead. */
const DATE_FALLBACK_AFTER_DAYS = 30;

/** Relative timestamp: "just now" / "5m ago" / "3h ago" / "2d ago" / "4w ago", and the
 * local date once the value is older than a month. Every bucket floors, so 90 seconds
 * reads "1m ago" rather than "2m ago" and no bucket ever overstates an age. */
export function relativeTime(
  value?: string | number | null,
  now: number = Date.now(),
): string {
  const ms =
    value == null ? 0 : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const diff = now - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < DATE_FALLBACK_AFTER_DAYS) return `${Math.floor(day / 7)}w ago`;
  return new Date(ms).toLocaleDateString();
}

/** Compact relative time for dense rails ("8h", "3d", "now"): the same buckets as
 * `relativeTime`, without the " ago" suffix that eats sidebar row width. A date
 * fallback carries no suffix and is returned as it is. */
export function relativeTimeShort(
  value?: string | number | null,
  now: number = Date.now(),
): string {
  const long = relativeTime(value, now);
  if (long === "just now") return "now";
  return long.endsWith(" ago") ? long.slice(0, -4) : long;
}

/** Precise elapsed time for a work log: "180ms", "4.3s", "1m 8.5s", "1h 2m". Null when
 *  there is nothing to report (missing, zero or negative). */
export function formatElapsed(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // Round to tenths before choosing the bucket, so 59,999 ms is "1m", never "60.0s".
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const minutes = Math.floor(tenths / 600);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const rest = tenths - minutes * 600;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${(rest / 10).toFixed(1)}s`;
}
