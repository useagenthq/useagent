import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { publishTrustedArtifact } from "../src/artifacts/publish";
import {
  artifactStorageKeyIsReferenced,
  reclaimUnreferencedLocalArtifacts,
} from "../src/artifacts/reclaim";
import { LocalArtifactStorage, setArtifactStorageForTest } from "../src/artifacts/storage";
import { withArtifactStorageKeyLock } from "../src/artifacts/storage-key-lock";
import { readTrustedImageOutput } from "../src/artifacts/trusted-output";
import { db } from "../src/db/client";
import { artifacts, providerEvents, runs, userUploads } from "../src/db/schema";
import { createUserUpload } from "../src/uploads/repo";
import "./helpers";
import { DEV_ORG_ID } from "../src/dev-org";

const runIds = new Set<string>();
const roots = new Set<string>();

async function waitForBlockedStorageKeyLock(storageKey: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rows = await db.execute(sql`
      with target as (
        select hashtextextended(${`artifact-storage:${storageKey}`}, 0) as value
      )
      select count(*)::int as count
      from pg_locks, target
      where locktype = 'advisory'
        and database = (select oid from pg_database where datname = current_database())
        and classid = (((target.value >> 32) & 4294967295)::oid)
        and objid = ((target.value & 4294967295)::oid)
        and objsubid = 1
        and not granted
    `);
    if (Number(rows[0]?.count) > 0) return;
    await Bun.sleep(10);
  }
  throw new Error(`no blocked waiter observed for artifact storage key ${storageKey}`);
}

async function createRun(runId: string): Promise<void> {
  runIds.add(runId);
  await db.insert(runs).values({
    id: runId,
    orgId: DEV_ORG_ID,
    userId: "user-artifact-race",
    prompt: "serialize artifact publication",
    model: "mock",
    engine: "mock",
    status: "completed",
    threadId: runId,
  });
}

function trustedBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...new TextEncoder().encode(crypto.randomUUID()),
  ]);
}

afterEach(async () => {
  setArtifactStorageForTest(null);
  for (const runId of runIds) {
    await db.delete(providerEvents).where(eq(providerEvents.runId, runId));
    await db.delete(artifacts).where(eq(artifacts.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
  }
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  runIds.clear();
  roots.clear();
});

describe("artifact storage publication/reclamation serialization", () => {
  test("publisher-first makes the reclaimer wait through metadata commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-artifact-publisher-first-"));
    roots.add(root);
    const bytes = trustedBytes();
    const storageKey = createHash("sha256").update(bytes).digest("hex");
    let hashOpened!: () => void;
    const opened = new Promise<void>((resolve) => { hashOpened = resolve; });
    let releasePublication!: () => void;
    const release = new Promise<void>((resolve) => { releasePublication = resolve; });
    class PausingStorage extends LocalArtifactStorage {
      override async sha256(key: string): Promise<string> {
        if (key !== storageKey) return super.sha256(key);
        const handle = await open(join(root, key.slice(0, 2), key), "r");
        try {
          hashOpened();
          await release;
          return createHash("sha256").update(await handle.readFile()).digest("hex");
        } finally {
          await handle.close();
        }
      }
    }
    const storage = new PausingStorage(root);
    setArtifactStorageForTest(storage);
    await storage.put(storageKey, bytes);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(join(root, storageKey.slice(0, 2), storageKey), old, old);
    const runId = crypto.randomUUID();
    await createRun(runId);
    const output = await readTrustedImageOutput({
      kind: "trusted_bytes",
      bytes,
      name: "result.png",
    }, 1_024);

    const publisher = publishTrustedArtifact({
      orgId: DEV_ORG_ID,
      userId: "user-artifact-race",
      runId,
      provider: "codex",
      sourceKey: "b".repeat(64),
      output,
    });
    await opened;
    const reclaimer = reclaimUnreferencedLocalArtifacts({ minAgeMs: 0, now: new Date() });
    await waitForBlockedStorageKeyLock(storageKey);
    releasePublication();

    const [published, reclaimed] = await Promise.all([publisher, reclaimer]);
    expect(published.record.storageKey).toBe(storageKey);
    expect(reclaimed.retained).toContain(storageKey);
    expect(reclaimed.removed).not.toContain(storageKey);
    expect(await storage.read(storageKey)).toEqual(bytes);

    const orphanBytes = new TextEncoder().encode(`orphan-${crypto.randomUUID()}`);
    const orphanKey = createHash("sha256").update(orphanBytes).digest("hex");
    await storage.put(orphanKey, orphanBytes);
    await utimes(join(root, orphanKey.slice(0, 2), orphanKey), old, old);
    const orphanReclaim = await reclaimUnreferencedLocalArtifacts({ minAgeMs: 0, now: new Date() });
    expect(orphanReclaim.removed).toContain(orphanKey);
    await expect(storage.read(orphanKey)).rejects.toThrow("artifact bytes are missing");
  });

  test("reclaimer-first makes the publisher wait and then publish fresh bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-artifact-reclaimer-first-"));
    roots.add(root);
    const bytes = trustedBytes();
    const storageKey = createHash("sha256").update(bytes).digest("hex");
    const storage = new LocalArtifactStorage(root);
    setArtifactStorageForTest(storage);
    await storage.put(storageKey, bytes);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(join(root, storageKey.slice(0, 2), storageKey), old, old);
    const runId = crypto.randomUUID();
    await createRun(runId);
    const output = await readTrustedImageOutput({
      kind: "trusted_bytes",
      bytes,
      name: "result.png",
    }, 1_024);
    let reclaimerLocked!: () => void;
    const locked = new Promise<void>((resolve) => { reclaimerLocked = resolve; });
    let releaseReclaimer!: () => void;
    const release = new Promise<void>((resolve) => { releaseReclaimer = resolve; });

    const reclaimer = storage.reclaimUnreferenced({
      referencedKeys: new Set(),
      minAgeMs: 0,
      now: new Date(),
      withStorageKeyLock: (key, action) =>
        withArtifactStorageKeyLock(key, async (tx) => {
          reclaimerLocked();
          await release;
          return action(() => artifactStorageKeyIsReferenced(key, tx));
        }),
    });
    await locked;
    const publisher = publishTrustedArtifact({
      orgId: DEV_ORG_ID,
      userId: "user-artifact-race",
      runId,
      provider: "codex",
      sourceKey: "c".repeat(64),
      output,
    });
    await waitForBlockedStorageKeyLock(storageKey);
    releaseReclaimer();

    const [reclaimed, published] = await Promise.all([reclaimer, publisher]);
    expect(reclaimed.removed).toContain(storageKey);
    expect(published.record.storageKey).toBe(storageKey);
    expect(await storage.read(storageKey)).toEqual(bytes);
  });

  test("a failed storage-key transaction rolls back its reference and releases the lock", async () => {
    const storageKey = "d".repeat(64);
    await expect(withArtifactStorageKeyLock(storageKey, async (tx) => {
      await createUserUpload({
        orgId: DEV_ORG_ID,
        userId: "user-artifact-race",
        name: "rollback.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        sha256: storageKey,
        storageKey,
        expiresAt: new Date(Date.now() + 60_000),
      }, tx);
      throw new Error("rollback-after-reference");
    })).rejects.toThrow("rollback-after-reference");
    expect(await db.select().from(userUploads).where(eq(userUploads.storageKey, storageKey)))
      .toHaveLength(0);

    let reacquired = false;
    await withArtifactStorageKeyLock(storageKey, async () => { reacquired = true; });
    expect(reacquired).toBe(true);
  });

});
