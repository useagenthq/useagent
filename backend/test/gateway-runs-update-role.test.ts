import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { GATEWAY_GRANTS } from "../src/db/gateway-grants";
import { createRun } from "../src/runs/repo";
import "./helpers";
import { DEV_ORG_ID } from "../src/dev-org";

const ORG = DEV_ORG_ID;

// The gateway's skill activation is a column-scoped UPDATE on runs. Every UPDATE
// on runs fires trg_validate_batched_child_run_update, whose function runs as the
// invoking role and reads child_thread_batch_items; the executor checks that read
// on the generic plan before the AND short-circuits, even though the guard only
// matters when the thread changes. Production shipped that trigger without the read grant and every
// playbook activation through the gateway died with 42501. This runs the exact
// gateway write under the manifest's grants, and shows the read grant is the one
// that makes the difference.
const runsGrants = GATEWAY_GRANTS.filter(
  (grant) => / ON runs[ ,]/.test(grant) || / ON child_thread_batch_items /.test(grant),
);

async function updateRunAsRestrictedRole(
  grants: readonly string[],
): Promise<{ failure: Error | null; updated: number }> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "gateway skill activation under the restricted role",
    model: "test",
    engine: "mock",
    orgId: ORG,
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  const role = `gateway_runs_${crypto.randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("rollback the isolated role fixture");
  let failure: Error | null = null;
  let updated = 0;
  // CREATE ROLE and its grants are transactional: nothing here outlives the test.
  await expect(db.transaction(async (tx) => {
    await tx.execute(sql.raw(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`));
    await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`));
    for (const grant of grants) {
      await tx.execute(sql.raw(grant.replaceAll("useagent_gateway", `"${role}"`)));
    }
    await tx.execute(sql.raw(`SET LOCAL ROLE "${role}"`));
    // The trigger is a deferred constraint trigger: it fires at commit, which the
    // gateway's own transaction reaches and this rolled-back fixture never does.
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    // A custom plan folds `NEW.thread_id IS DISTINCT FROM OLD.thread_id` to false
    // and drops the EXISTS, so the read is never permission-checked on a fresh
    // session; the generic plan keeps it and checks it. Production reached the
    // generic plan; the test forces it so the outcome does not depend on how many
    // times the trigger ran before.
    await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
    try {
      const result = await tx.execute(sql`
        update runs set skill_id = null, skill_version = null, skill_content_hash = null, updated_at = now()
        where id = ${runId} and org_id = ${ORG} returning id`);
      updated = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []).length;
    } catch (error) {
      // Drizzle wraps the driver error; the Postgres message is the cause.
      const cause = (error as { cause?: unknown }).cause;
      failure = new Error(String(cause instanceof Error ? cause.message : error));
    }
    throw rollback;
  })).rejects.toBe(rollback);
  return { failure, updated };
}


describe("restricted gateway skill activation on runs", () => {
  test("the manifest's grants let the gateway update a run's skill columns", async () => {
    expect(runsGrants).toContain("GRANT SELECT (org_id, child_run_id) ON child_thread_batch_items TO useagent_gateway");
    expect(await updateRunAsRestrictedRole(runsGrants)).toEqual({ failure: null, updated: 1 });
  });

  test("without the batched-child read grant the same update is refused by the trigger", async () => {
    const withoutRead = runsGrants.filter((grant) => !grant.includes("child_thread_batch_items"));
    const { failure } = await updateRunAsRestrictedRole(withoutRead);
    expect(failure).not.toBeNull();
    expect(String(failure)).toMatch(/permission denied for table child_thread_batch_items/);
  });
});
