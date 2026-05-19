import { backendFetch } from "@/lib/backend-fetch";
import { envelope } from "@/lib/runs";
import type { FiringRecord, ScheduleRecord } from "./schedules-data";

/**
 * Thin fetch layer for the schedules endpoints. Routing (backend origin +
 * cookie forwarding on the server, relative path on the client) lives in
 * `backendFetch`. Every call throws on a non-2xx so callers can surface an
 * error or revert an optimistic update.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchSchedules(): Promise<ScheduleRecord[]> {
  const res = await backendFetch("/api/schedules", { cache: "no-store" });
  if (!res.ok) throw new Error(`schedules ${res.status}`);
  return envelope(await res.json(), "schedules") as ScheduleRecord[];
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
  const res = await backendFetch("/api/schedules", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `create schedule ${res.status}`);
  }
  return (await res.json()) as ScheduleRecord;
}

export type SchedulePatch = Partial<CreateScheduleInput> & { enabled?: boolean };

export async function updateSchedule(
  id: string,
  patch: SchedulePatch,
): Promise<ScheduleRecord> {
  const res = await backendFetch(`/api/schedules/${id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update schedule ${res.status}`);
  return (await res.json()) as ScheduleRecord;
}

/** Manual fire — returns the new run id. */
export async function runScheduleNow(id: string): Promise<string> {
  const res = await backendFetch(`/api/schedules/${id}/run-now`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`run-now ${res.status}`);
  const data = (await res.json()) as { run_id: string };
  return data.run_id;
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await backendFetch(`/api/schedules/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete schedule ${res.status}`);
}

export async function fetchHistory(id: string): Promise<FiringRecord[]> {
  const res = await backendFetch(`/api/schedules/${id}/history`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`history ${res.status}`);
  return envelope(await res.json(), "firings") as FiringRecord[];
}
