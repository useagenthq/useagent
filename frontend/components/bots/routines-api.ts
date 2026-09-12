import { backendFetch } from "@/lib/backend-fetch";
import { type ApiFiring, type ApiRoutine, apiErrorText, OFFLINE_MESSAGE } from "./types";

const jsonHeaders = { "content-type": "application/json" } as const;

/** backendFetch, with a network failure turned into the message the row shows. */
async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await backendFetch(path, init);
  } catch {
    throw new Error(OFFLINE_MESSAGE);
  }
}

async function expectOk<T>(response: Response, fallback: string): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T;
  if (!response.ok) throw new Error(apiErrorText(data, fallback));
  return data;
}

export async function fetchRoutines(botId: string): Promise<ApiRoutine[]> {
  const data = await expectOk<{ routines?: ApiRoutine[] }>(await request(`/api/bots/${botId}/routines`), "Unable to load routines. Try again.");
  return data.routines ?? [];
}

export interface CreateRoutineInput {
  name: string;
  cron: string;
  prompt: string;
  timezone?: string | null;
}

export async function createRoutine(botId: string, input: CreateRoutineInput): Promise<ApiRoutine> {
  const data = await expectOk<{ routine: ApiRoutine }>(
    await request(`/api/bots/${botId}/routines`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) }),
    "Unable to create the routine. Try again.",
  );
  return data.routine;
}

export async function updateRoutine(botId: string, routineId: string, patch: Partial<CreateRoutineInput> & { enabled?: boolean }): Promise<ApiRoutine | null> {
  const data = await expectOk<{ routine: ApiRoutine | null }>(
    await request(`/api/bots/${botId}/routines/${routineId}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(patch) }),
    "Unable to update the routine. Try again.",
  );
  return data.routine;
}

export async function deleteRoutine(botId: string, routineId: string): Promise<void> {
  const response = await request(`/api/bots/${botId}/routines/${routineId}`, { method: "DELETE" });
  if (!response.ok) throw new Error(apiErrorText(await response.json().catch(() => ({})), "Unable to delete the routine. Try again."));
}

/** Test run: fires now into the bot's home thread. Returns the run and the routine as fired. */
export async function runRoutineNow(botId: string, routineId: string): Promise<{ runId: string; routine: ApiRoutine }> {
  return expectOk<{ runId: string; routine: ApiRoutine }>(
    await request(`/api/bots/${botId}/routines/${routineId}/run-now`, { method: "POST" }),
    "Unable to start the routine. Try again.",
  );
}

export async function fetchRoutineHistory(botId: string, routineId: string): Promise<ApiFiring[]> {
  const data = await expectOk<{ firings?: ApiFiring[] }>(
    await request(`/api/bots/${botId}/routines/${routineId}/history`),
    "Unable to load the routine history. Try again.",
  );
  return data.firings ?? [];
}
