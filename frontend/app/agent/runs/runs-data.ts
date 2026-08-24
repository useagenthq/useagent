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
import {
  decodeApiRunSummary,
  type ApiRunSummary,
  type RunStatus,
} from '@useagent/agent-client/wire';

export type Run = ApiRunSummary;

function decodeRunsEnvelope(value: unknown): Run[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as { runs?: unknown }).runs;
  if (!Array.isArray(rows)) return [];
  return rows.map(decodeApiRunSummary).filter((run): run is Run => run !== null);
}

export async function fetchRuns(signal?: AbortSignal): Promise<Run[]> {
  const res = await backendFetch('/api/runs?view=summary&limit=100&include_active=1', {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`runs request failed: ${res.status}`);
  return decodeRunsEnvelope(await res.json());
}

let sidebarRequest: Promise<Run[]> | null = null;
let sidebarDirty = false;

async function fetchSidebarSnapshot(): Promise<Run[]> {
  const res = await backendFetch('/api/runs?view=summary&limit=100&include_active=1', {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`runs request failed: ${res.status}`);
  return decodeRunsEnvelope(await res.json());
}

async function fetchFreshSidebarRuns(): Promise<Run[]> {
  let result: Run[] = [];
  let failure: unknown = null;
  do {
    sidebarDirty = false;
    try {
      result = await fetchSidebarSnapshot();
      failure = null;
    } catch (error) {
      failure = error;
    }
  } while (sidebarDirty);
  if (failure) throw failure;
  return result;
}

function startSidebarRequest(): Promise<Run[]> {
  const request = fetchFreshSidebarRuns().finally(() => {
    if (sidebarRequest === request) sidebarRequest = null;
  });
  sidebarRequest = request;
  return request;
}

/** Shared compact request for the two sidebar consumers. It only deduplicates
 * concurrent calls; completed responses are never cached, so SSE invalidation
 * and recovery polling always observe fresh state. */
export function fetchSidebarRuns(options: { revalidate?: boolean } = {}): Promise<Run[]> {
  if (sidebarRequest) {
    if (options.revalidate) sidebarDirty = true;
    return sidebarRequest;
  }
  return startSidebarRequest();
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

export function statusTone(status: RunStatus): RunTone {
  if (status === 'running') return 'live';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return 'idle';
}
