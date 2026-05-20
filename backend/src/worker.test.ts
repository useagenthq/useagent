import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_TIMING_OUTCOMES } from "./runs/run-timing";
import { ensureRunWorkdir } from "./worker";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("worker run workdir", () => {
  test("initializes a missing git boundary once and skips the subprocess on resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-worker-"));
    temporaryRoots.push(root);
    const workdir = join(root, "thread-1");
    let initializations = 0;
    const initializeGit = async (path: string): Promise<boolean> => {
      initializations += 1;
      await mkdir(join(path, ".git"));
      await writeFile(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
      return true;
    };

    expect(await ensureRunWorkdir(workdir, initializeGit)).toBe(RUN_TIMING_OUTCOMES.ready);
    expect(await ensureRunWorkdir(workdir, initializeGit)).toBe(RUN_TIMING_OUTCOMES.hit);
    expect(initializations).toBe(1);
  });

  test("keeps git initialization best-effort and reports an unavailable boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-worker-"));
    temporaryRoots.push(root);

    expect(await ensureRunWorkdir(join(root, "thread-2"), async () => false)).toBe(
      RUN_TIMING_OUTCOMES.unavailable,
    );
    expect(await ensureRunWorkdir(join(root, "thread-claimed-ready"), async () => true)).toBe(
      RUN_TIMING_OUTCOMES.unavailable,
    );
    await expect(
      ensureRunWorkdir(join(root, "thread-3"), async () => {
        throw new Error("git unavailable");
      }),
    ).resolves.toBe(RUN_TIMING_OUTCOMES.unavailable);
  });
});
