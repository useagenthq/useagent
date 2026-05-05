import { createRun } from "../runs/repo";
import { spawnWorker } from "../worker";
import { recordFiring, type ScheduleRecord } from "./repo";
import type { ScheduleTrigger } from "../db/schema";

/**
 * Fire a schedule: create a run through the EXISTING run-creation path
 * (`createRun` + `spawnWorker`, the same primitives `POST /api/runs` uses) and
 * append an immutable firing row. A firing is always a fresh thread root
 * (`parentRunId: null`, `threadId === runId`). Shared by the 60s scheduler loop
 * (`trigger: "cron"`) and the manual run-now route (`trigger: "manual"`).
 * Returns the new run id.
 */
export async function fireSchedule(
  schedule: ScheduleRecord,
  trigger: ScheduleTrigger,
): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: schedule.prompt,
    model: schedule.model,
    engine: schedule.engine,
    orgId: schedule.orgId,
    userId: schedule.userId,
    parentRunId: null,
    threadId: runId,
  });
  spawnWorker(runId);
  await recordFiring({ scheduleId: schedule.id, runId, trigger });
  return runId;
}
