import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { GATEWAY_GRANTS } from "../src/db/gateway-grants";
import { assertSandboxMinutes } from "../src/runs/sandbox-minutes";
import "./helpers";
import { DEV_ORG_ID } from "../src/dev-org";

// The gateway process accepts new work through the single door (child sessions,
// child batches, run-automation-now) under the restricted role, and the door
// reads the member's sandbox minutes ledger. This runs that exact read as a
// role holding the manifest's grants, and shows the ledger grant is the one
// that makes the difference.
const ledgerGrants = GATEWAY_GRANTS.filter((grant) => / ON sandbox_minutes_entries /.test(grant));

async function checkCapAsRestrictedRole(grants: readonly string[]): Promise<Error | null> {
  const role = `gateway_minutes_${crypto.randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("rollback the isolated role fixture");
  let failure: Error | null = null;
  // CREATE ROLE and its grants are transactional: nothing here outlives the test.
  await expect(db.transaction(async (tx) => {
    await tx.execute(sql.raw(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`));
    await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`));
    for (const grant of grants) {
      await tx.execute(sql.raw(grant.replaceAll("useagent_gateway", `"${role}"`)));
    }
    await tx.execute(sql.raw(`SET LOCAL ROLE "${role}"`));
    try {
      await assertSandboxMinutes(DEV_ORG_ID, "user-under-the-cap", tx);
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      failure = new Error(String(cause instanceof Error ? cause.message : error));
    }
    throw rollback;
  })).rejects.toBe(rollback);
  return failure;
}

describe("restricted gateway sandbox minutes check at the door", () => {
  test("the manifest's grants let the gateway read the ledger the door checks", async () => {
    expect(ledgerGrants).toEqual(["GRANT SELECT ON sandbox_minutes_entries TO useagent_gateway"]);
    expect(await checkCapAsRestrictedRole(ledgerGrants)).toBeNull();
  });

  test("without the ledger grant the same acceptance is refused by Postgres", async () => {
    const failure = await checkCapAsRestrictedRole([]);
    expect(failure).not.toBeNull();
    expect(String(failure)).toMatch(/permission denied for table sandbox_minutes_entries/);
  });
});
