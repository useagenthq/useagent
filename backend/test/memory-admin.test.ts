import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  enqueueCapture,
  getCapture,
  listCapturesForOrg,
  resolveDeliveringOrphan,
  retryDeadCapture,
} from "../src/memory/capture-outbox";
import type { MemoryIdentity } from "../src/memory/team-memory";
import { createRun } from "../src/runs/repo";
import { uid } from "./helpers";

// Memory Hub admin surface (task #75). The outbox has no org column — tenancy is
// enforced by a JOIN to `runs`. These lock: (1) list is org-scoped, (2) manual
// retry only fires on `dead` rows in your org and resets the attempt budget while
// preserving the committed payload, (3) a `delivering` orphan resolves only on an
// explicit operator decision, org-scoped. DB-backed against useAgent_test.

const ORG_A = "org-skynet-dev"; // the seeded dev org
const ORG_B = "org-other-test";

function orgIdentity(orgId: string, runId: string): MemoryIdentity {
  return {
    teamId: orgId,
    agentId: "skynet-backend",
    userId: `org:${orgId}`,
    actorUserId: "u-1",
    sessionId: "thread-1",
    runId,
  };
}

/** Insert a run + its capture row, then force the outbox state. */
async function seedCapture(orgId: string, state: string, prompt = "remember this"): Promise<string> {
  const runId = uid("run");
  await createRun({
    id: runId,
    prompt,
    model: "claude-opus-5",
    engine: "mock",
    orgId,
    userId: null,
    parentRunId: null,
    threadId: runId,
  });
  await enqueueCapture(runId, orgIdentity(orgId, runId), { prompt, summary: "did it" }, "org");
  await db.execute(sql`update memory_outbox set state = ${state} where id = ${runId}`);
  return runId;
}

beforeEach(async () => {
  await db.execute(sql`delete from memory_outbox`);
  // Enabled so enqueue's identity resolves; nothing here hits the network.
  process.env.MEMORY_API_URL = "http://memory.invalid";
});
afterEach(async () => {
  await db.execute(sql`delete from memory_outbox`);
  delete process.env.MEMORY_API_URL;
});

describe("listCapturesForOrg — org-scoped inspection", () => {
  test("returns only this org's captures, with state + scope + previews, no identity", async () => {
    const mine = await seedCapture(ORG_A, "delivered", "my capture prompt");
    await seedCapture(ORG_B, "pending");

    const rows = await listCapturesForOrg(ORG_A);
    expect(rows.map((r) => r.runId)).toContain(mine);
    expect(rows.every((r) => r.runId !== undefined)).toBe(true);
    const row = rows.find((r) => r.runId === mine)!;
    expect(row.state).toBe("delivered");
    expect(row.scope).toBe("org");
    expect(row.promptPreview).toBe("my capture prompt");
    // The admin row NEVER leaks the transport identity/pool ids.
    expect(JSON.stringify(row)).not.toContain("agentId");
    expect(JSON.stringify(row)).not.toContain("org:org-skynet-dev");

    // ORG_B's row must not appear in ORG_A's view.
    const bId = rows.find((r) => r.runId !== mine);
    expect(bId).toBeUndefined();
  });

  test("surfaces crash-orphaned `delivering` rows (the manual-inspection path)", async () => {
    const orphan = await seedCapture(ORG_A, "delivering");
    const rows = await listCapturesForOrg(ORG_A);
    expect(rows.find((r) => r.runId === orphan)?.state).toBe("delivering");
  });
});

describe("retryDeadCapture — manual re-enqueue of a dead row", () => {
  test("dead → pending with a fresh attempt budget; payload (scope) preserved", async () => {
    const runId = await seedCapture(ORG_A, "dead");
    // Simulate an exhausted budget + stale error.
    await db.execute(
      sql`update memory_outbox set attempt_count = 6, last_error = 'boom' where id = ${runId}`,
    );
    const payloadBefore = String((await getCapture(runId))?.payload);

    const ok = await retryDeadCapture(runId, ORG_A);
    expect(ok).toBe(true);

    const row = await getCapture(runId);
    expect(row?.state).toBe("pending");
    expect(row?.attemptCount).toBe(0);
    expect(row?.lastError).toBeNull();
    // The committed payload — destination scope + identity — is reused verbatim.
    expect(String(row?.payload)).toBe(payloadBefore);
    expect(JSON.parse(String(row?.payload)).scope).toBe("org");
  });

  test("refuses a non-dead row and a cross-org row", async () => {
    const pending = await seedCapture(ORG_A, "pending");
    expect(await retryDeadCapture(pending, ORG_A)).toBe(false); // wrong state

    const otherOrgDead = await seedCapture(ORG_B, "dead");
    expect(await retryDeadCapture(otherOrgDead, ORG_A)).toBe(false); // wrong org
    expect((await getCapture(otherOrgDead))?.state).toBe("dead"); // untouched
  });
});

describe("resolveDeliveringOrphan — explicit operator decision", () => {
  test("resolve marks delivered; discard dead-letters; both only from `delivering`", async () => {
    const a = await seedCapture(ORG_A, "delivering");
    expect(await resolveDeliveringOrphan(a, ORG_A, "delivered")).toBe(true);
    expect((await getCapture(a))?.state).toBe("delivered");

    const b = await seedCapture(ORG_A, "delivering");
    expect(await resolveDeliveringOrphan(b, ORG_A, "discard")).toBe(true);
    expect((await getCapture(b))?.state).toBe("dead");

    // A delivered row is not a delivering orphan → no-op.
    expect(await resolveDeliveringOrphan(a, ORG_A, "discard")).toBe(false);
  });

  test("refuses a cross-org orphan", async () => {
    const orphan = await seedCapture(ORG_B, "delivering");
    expect(await resolveDeliveringOrphan(orphan, ORG_A, "delivered")).toBe(false);
    expect((await getCapture(orphan))?.state).toBe("delivering"); // untouched
  });
});
