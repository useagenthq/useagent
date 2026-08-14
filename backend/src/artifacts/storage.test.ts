import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStorage } from "./storage";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("LocalArtifactStorage", () => {
  test("makes shared artifact directories traversable and bytes group-readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-artifacts-"));
    roots.add(root);
    const key = "a".repeat(64);
    const storage = new LocalArtifactStorage(root);

    await storage.put(key, new TextEncoder().encode("durable"));

    const directoryMode = (await stat(join(root, "aa"))).mode & 0o777;
    const fileMode = (await stat(join(root, "aa", key))).mode & 0o777;
    expect(directoryMode).toBe(0o770);
    expect(fileMode).toBe(0o660);
    expect(new TextDecoder().decode(await storage.read(key))).toBe("durable");
  });

  test("does not try to change ownership-sensitive mode on existing bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-artifacts-"));
    roots.add(root);
    const key = "b".repeat(64);
    const storage = new LocalArtifactStorage(root);

    await storage.put(key, new TextEncoder().encode("shared"));
    const target = join(root, "bb", key);
    await chmod(target, 0o440);
    await storage.put(key, new TextEncoder().encode("must-not-overwrite"));

    expect((await stat(target)).mode & 0o777).toBe(0o440);
    expect(new TextDecoder().decode(await storage.read(key))).toBe("shared");
  });

  test("preserves an existing shared digest directory owned by another publisher", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-artifacts-"));
    roots.add(root);
    const key = "c".repeat(64);
    const directory = join(root, "cc");
    await mkdir(directory, { mode: 0o775 });
    await chmod(directory, 0o775);
    const storage = new LocalArtifactStorage(root);

    await storage.put(key, new TextEncoder().encode("cross-service"));

    expect((await stat(directory)).mode & 0o777).toBe(0o775);
    expect(new TextDecoder().decode(await storage.read(key))).toBe("cross-service");
  });

  test("reclaims only old content-addressed bytes with no proven reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-artifacts-"));
    roots.add(root);
    const referenced = "d".repeat(64);
    const orphan = "e".repeat(64);
    const invalid = "not-a-digest";
    const storage = new LocalArtifactStorage(root);

    await storage.put(referenced, new TextEncoder().encode("keep"));
    await storage.put(orphan, new TextEncoder().encode("delete"));
    await writeFile(join(root, "ee", invalid), "ignore");

    const dryRun = await storage.reclaimUnreferenced({
      referencedKeys: new Set([referenced]),
      minAgeMs: 0,
      now: new Date(Date.now() + 1_000),
      dryRun: true,
    });
    expect(dryRun.removed).toEqual([orphan]);
    expect(await storage.size(orphan)).toBe(6);

    const result = await storage.reclaimUnreferenced({
      referencedKeys: new Set([referenced]),
      minAgeMs: 0,
      now: new Date(Date.now() + 1_000),
    });
    expect(result.removed).toEqual([orphan]);
    expect(new TextDecoder().decode(await storage.read(referenced))).toBe("keep");
    await expect(storage.read(orphan)).rejects.toThrow("artifact bytes are missing");
  });

  test("ignores digest-prefix entries that are not real directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-artifacts-"));
    roots.add(root);
    const storage = new LocalArtifactStorage(root);
    await writeFile(join(root, "ff"), "not a directory");
    await symlink(root, join(root, "ab"));

    await expect(
      storage.reclaimUnreferenced({ referencedKeys: new Set(), minAgeMs: 0 }),
    ).resolves.toEqual({ scanned: 0, removed: [], retained: [] });
  });

  test("restores quarantined bytes when a reference appears during reclaim", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-artifacts-"));
    roots.add(root);
    const key = "1".repeat(64);
    const storage = new LocalArtifactStorage(root);
    await storage.put(key, new TextEncoder().encode("published-during-gc"));

    const result = await storage.reclaimUnreferenced({
      referencedKeys: new Set(),
      minAgeMs: 0,
      now: new Date(Date.now() + 1_000),
      isReferenced: async () => true,
    });

    expect(result).toEqual({ scanned: 1, removed: [], retained: [key] });
    expect(new TextDecoder().decode(await storage.read(key))).toBe("published-during-gc");
  });

  test("does not delete a fresh canonical copy published after quarantine", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-artifacts-"));
    roots.add(root);
    const key = "2".repeat(64);
    const storage = new LocalArtifactStorage(root);
    await storage.put(key, new TextEncoder().encode("old"));

    const result = await storage.reclaimUnreferenced({
      referencedKeys: new Set(),
      minAgeMs: 0,
      now: new Date(Date.now() + 1_000),
      isReferenced: async () => {
        await storage.put(key, new TextEncoder().encode("fresh"));
        return true;
      },
    });

    expect(result).toEqual({ scanned: 1, removed: [], retained: [key] });
    expect(new TextDecoder().decode(await storage.read(key))).toBe("fresh");
  });
});
