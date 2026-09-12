import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupRepositoryScratch,
  repositoryScratchRoot,
} from "../src/wiki-gen/clone";

describe("repository clone scratch root", () => {
  test("uses the configured disk-backed root and keeps the system temp fallback", () => {
    expect(repositoryScratchRoot({ SCRATCH_DIR: " /var/lib/useagent/scratch " }))
      .toBe("/var/lib/useagent/scratch");
    expect(repositoryScratchRoot({ SCRATCH_DIR: " " })).toBe(tmpdir());
    expect(repositoryScratchRoot({})).toBe(tmpdir());
  });

  test("removes only current and legacy repository clone directories after a crash", async () => {
    expect(await cleanupRepositoryScratch({})).toEqual({ removed: 0, failures: [] });
    const root = await mkdtemp(join(tmpdir(), "useagent-scratch-test-"));
    try {
      await Promise.all([
        mkdir(join(root, "useagent-wiki-current")),
        mkdir(join(root, "useagent-read-current")),
        mkdir(join(root, "skynet-wiki-legacy")),
        mkdir(join(root, "skynet-read-legacy")),
        mkdir(join(root, "unrelated")),
      ]);

      expect(await cleanupRepositoryScratch({ SCRATCH_DIR: root })).toEqual({
        removed: 4,
        failures: [],
      });
      expect(await readdir(root)).toEqual(["unrelated"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
