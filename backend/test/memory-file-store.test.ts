import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  latestMemoryFilesForPools,
  saveMemoryFileSnapshot,
  type SnapshotPool,
} from "../src/memory/memory-file-store";
import { uid } from "./helpers";

// The durable memory-file snapshot store — the Postgres-backed sync machinery that
// gives a new session immediate cross-session continuity (independent of Tencent
// distillation lag). Proves: round-trip, at-most-once dedup by content, pool
// isolation (personal vs org partitions never cross), and latest-wins per pool.
// Importing ./helpers runs the boot migrator, so this also exercises migration
// 0021 on the empty skynet_test DB.

const org = (orgId: string): SnapshotPool => ({
  teamId: orgId,
  poolUserId: `org:${orgId}`,
  scope: "org",
});
const personal = (orgId: string, userId: string): SnapshotPool => ({
  teamId: orgId,
  poolUserId: userId,
  scope: "personal",
});

beforeEach(async () => {
  await db.execute(sql`delete from memory_files`);
});

describe("memory-file store", () => {
  test("round-trips the latest body for a pool", async () => {
    const pool = personal("org-1", "u-42");
    const wrote = await saveMemoryFileSnapshot({
      runId: uid("run"),
      threadId: "thread-a",
      pool,
      content: "- favourite color is teal-1234",
    });
    expect(wrote).toBe(true);

    const bodies = await latestMemoryFilesForPools([pool]);
    expect(bodies).toEqual([{ scope: "personal", body: "- favourite color is teal-1234" }]);
  });

  test("unchanged content is a no-op (at-most-once, no duplicate row)", async () => {
    const pool = org("org-1");
    const first = await saveMemoryFileSnapshot({
      runId: uid("run"),
      threadId: "t1",
      pool,
      content: "- same fact",
    });
    const second = await saveMemoryFileSnapshot({
      runId: uid("run"),
      threadId: "t2",
      pool,
      content: "- same fact",
    });
    expect(first).toBe(true);
    expect(second).toBe(false); // identical to the pool's latest → skipped

    const [{ n }] = (await db.execute(
      sql`select count(*)::int as n from memory_files`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  test("newest snapshot wins per pool", async () => {
    const pool = personal("org-1", "u-9");
    await saveMemoryFileSnapshot({ runId: uid("run"), threadId: "t1", pool, content: "- old" });
    await saveMemoryFileSnapshot({ runId: uid("run"), threadId: "t2", pool, content: "- new" });
    const bodies = await latestMemoryFilesForPools([pool]);
    expect(bodies).toEqual([{ scope: "personal", body: "- new" }]);
  });

  test("pool isolation: personal and org partitions never cross", async () => {
    const personalPool = personal("org-1", "u-1");
    const orgPool = org("org-1");
    await saveMemoryFileSnapshot({
      runId: uid("run"),
      threadId: "t1",
      pool: personalPool,
      content: "- personal secret",
    });
    await saveMemoryFileSnapshot({
      runId: uid("run"),
      threadId: "t2",
      pool: orgPool,
      content: "- org shared",
    });

    // A personal run reads personal FIRST, then org (priority order).
    const personalRun = await latestMemoryFilesForPools([personalPool, orgPool]);
    expect(personalRun).toEqual([
      { scope: "personal", body: "- personal secret" },
      { scope: "org", body: "- org shared" },
    ]);

    // An org run reads org ONLY — never the personal partition.
    const orgRun = await latestMemoryFilesForPools([orgPool]);
    expect(orgRun).toEqual([{ scope: "org", body: "- org shared" }]);

    // A DIFFERENT user's personal pool sees nothing from u-1.
    const otherUser = await latestMemoryFilesForPools([personal("org-1", "u-2")]);
    expect(otherUser).toEqual([]);
  });

  test("a different org's shared pool is isolated", async () => {
    await saveMemoryFileSnapshot({
      runId: uid("run"),
      threadId: "t1",
      pool: org("org-1"),
      content: "- org one fact",
    });
    const orgTwo = await latestMemoryFilesForPools([org("org-2")]);
    expect(orgTwo).toEqual([]);
  });
});
