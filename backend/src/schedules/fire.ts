import { acceptRunCommand } from "../commands";
import { pumpThread } from "../worker";
import { recordFiring, type ScheduleRecord } from "./repo";
import type { ScheduleTrigger } from "../db/schema";

/**
 * Fire a schedule: create a run through the durable command lane (the same
 * `acceptRunCommand` + mailbox pump `POST /api/runs` uses) and append an
 * immutable firing row. A firing is always a fresh thread root
 * (`parentRunId: null`, `threadId === runId`). Shared by the 60s scheduler loop
 * (`trigger: "cron"`) and the manual run-now route (`trigger: "manual"`).
 * Returns the new run id.
 */
export async function fireSchedule(
  schedule: ScheduleRecord,
  trigger: ScheduleTrigger,
): Promise<string> {
  const runId = crypto.randomUUID();
  await acceptRunCommand({
    idempotencyKey: null,
    orgId: schedule.orgId,
    actorId: schedule.userId,
    run: {
      id: runId,
      prompt: schedule.prompt,
      model: schedule.model,
      engine: schedule.engine,
      parentRunId: null,
      threadId: runId,
      repo: null,
      // Scheduled runs are always fresh roots — organization memory by default.
      memoryScope: "org",
    },
  });
  await pumpThread(runId);
  await recordFiring({ scheduleId: schedule.id, runId, trigger });
  return runId;
}
