import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
});
