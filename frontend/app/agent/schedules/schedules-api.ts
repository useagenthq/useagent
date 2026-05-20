import { backendFetch } from "@/lib/backend-fetch";
import { envelope } from "@/lib/runs";
import type { FiringRecord, ScheduleRecord } from "./schedules-data";

/**
 * Thin fetch layer for the Automations endpoints. Routing (backend origin +
 * cookie forwarding on the server, relative path on the client) lives in
 * `backendFetch`. Every call throws on a non-2xx so callers can surface an
 * error or revert an optimistic update.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchSchedules(signal?: AbortSignal): Promise<ScheduleRecord[]> {
  const res = await backendFetch("/api/automations", { cache: "no-store", signal });
  if (!res.ok) throw new Error(`automations ${res.status}`);
  const body = await res.json();
  return envelope(body, "automations") as ScheduleRecord[];
}

export interface CreateScheduleInput {
  name: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
  engine: string;
}

export async function createSchedule(
  input: CreateScheduleInput,
): Promise<ScheduleRecord> {
  const res = await backendFetch("/api/automations", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `create automation ${res.status}`);
  }
  return (await res.json()) as ScheduleRecord;
}

export type SchedulePatch = Partial<CreateScheduleInput> & { enabled?: boolean };

export async function updateSchedule(
  id: string,
  patch: SchedulePatch,
): Promise<ScheduleRecord> {
  const res = await backendFetch(`/api/automations/${id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update automation ${res.status}`);
  return (await res.json()) as ScheduleRecord;
}

/** Manual fire — returns the new run id. */
export async function runScheduleNow(id: string): Promise<string> {
  const res = await backendFetch(`/api/automations/${id}/run-now`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`run-now ${res.status}`);
  const data = (await res.json()) as { run_id: string };
  return data.run_id;
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await backendFetch(`/api/automations/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete automation ${res.status}`);
}

export async function fetchHistory(id: string, signal?: AbortSignal): Promise<FiringRecord[]> {
  const res = await backendFetch(`/api/automations/${id}/history`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`history ${res.status}`);
  return envelope(await res.json(), "firings") as FiringRecord[];
}
