import { backendFetch } from "@/lib/backend-fetch";
import { type ApiFiring, type ApiRoutine, apiErrorText } from "./types";

const jsonHeaders = { "content-type": "application/json" } as const;

async function expectOk<T>(response: Response, fallback: string): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T;
  if (!response.ok) throw new Error(apiErrorText(data, fallback));
  return data;
}

export async function fetchRoutines(botId: string): Promise<ApiRoutine[]> {
  const data = await expectOk<{ routines?: ApiRoutine[] }>(await backendFetch(`/api/bots/${botId}/routines`), "Could not load routines.");
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
    await backendFetch(`/api/bots/${botId}/routines`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) }),
    "Could not create the routine.",
  );
  return data.routine;
}

export async function updateRoutine(botId: string, routineId: string, patch: Partial<CreateRoutineInput> & { enabled?: boolean }): Promise<ApiRoutine | null> {
  const data = await expectOk<{ routine: ApiRoutine | null }>(
    await backendFetch(`/api/bots/${botId}/routines/${routineId}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(patch) }),
    "Could not update the routine.",
  );
  return data.routine;
}

export async function deleteRoutine(botId: string, routineId: string): Promise<void> {
  const response = await backendFetch(`/api/bots/${botId}/routines/${routineId}`, { method: "DELETE" });
  if (!response.ok) throw new Error(apiErrorText(await response.json().catch(() => ({})), "Could not delete the routine."));
}

/** Test run: fires now into the bot's home thread. */
export async function runRoutineNow(botId: string, routineId: string): Promise<string> {
  const data = await expectOk<{ runId: string }>(
    await backendFetch(`/api/bots/${botId}/routines/${routineId}/run-now`, { method: "POST" }),
    "Could not start the routine.",
  );
  return data.runId;
}

export async function fetchRoutineHistory(botId: string, routineId: string): Promise<ApiFiring[]> {
  const data = await expectOk<{ firings?: ApiFiring[] }>(
    await backendFetch(`/api/bots/${botId}/routines/${routineId}/history`),
    "Could not load the routine history.",
  );
  return data.firings ?? [];
}
