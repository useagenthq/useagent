/**
 * Shared, isomorphic helpers for the Active runs surface. Imported by both the
 * server page (initial SSR fetch, so real prompts render server-side) and the
 * realtime invalidation stream plus a low-frequency recovery poll in
 * `runs-list.tsx`.
 *
 * Fetching goes through `lib/backend-fetch` — on the server it hits the backend
 * origin directly and forwards the session cookie; on the client it uses a
 * relative `/api/...` path proxied by the next.config rewrite.
 *
 * Wire shape from the existing backend `GET /api/runs`:
 *   { runs: [{ id, prompt, status, summary, duration_ms, engine, steps: [...] }] }
 */

import type { DotTone } from '@/components/shared/status-dot';
import { backendFetch } from '@/lib/backend-fetch';

export interface RunStep {
  kind: string;
  label: string;
  chip: string | null;
  code_json: string | null;
}

export interface Run {
  id: string;
  prompt: string;
  status: string;
  summary: string | null;
  duration_ms: number | null;
  engine: string;
  steps?: RunStep[];
}

export async function fetchRuns(signal?: AbortSignal): Promise<Run[]> {
  const res = await backendFetch('/api/runs', { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`runs request failed: ${res.status}`);
  const data = (await res.json()) as { runs?: Run[] };
  return data.runs ?? [];
}

export type RunTone = 'live' | 'success' | 'error' | 'idle';

/** Map a run tone onto the shared StatusDot primitive props (Run cell + sidebar
 * Recents share this). */
export const TONE_TO_DOT: Record<
  RunTone,
  { tone: DotTone; pulse?: boolean; hollow?: boolean }
> = {
  live: { tone: 'away', pulse: true },
  success: { tone: 'success' },
  error: { tone: 'error' },
  idle: { tone: 'neutral', hollow: true },
};

export function statusTone(status: string): RunTone {
  const s = status.toLowerCase();
  if (['running', 'active', 'in_progress', 'live', 'streaming'].includes(s)) {
    return 'live';
  }
  if (['completed', 'succeeded', 'success', 'done'].includes(s)) {
    return 'success';
  }
  if (['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(s)) {
    return 'error';
  }
  return 'idle';
}
