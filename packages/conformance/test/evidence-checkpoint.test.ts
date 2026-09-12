import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConformanceCheckpoint } from "../src/evidence-checkpoint";

describe("conformance evidence checkpoints", () => {
  test("atomically replaces partial evidence with the latest completed result set", async () => {
    const root = await mkdtemp(join(tmpdir(), "conformance-checkpoint-"));
    const output = join(root, "candidate.json");

    await writeConformanceCheckpoint(output, {
      complete: false,
      expectedTotal: 2,
      passed: 1,
      provider: "sandbox-provider",
      results: [{ caseId: "repo-clone", engine: "codex", passed: true, errors: [] }],
      snapshot: "runtime-template",
      total: 1,
    });
    await writeConformanceCheckpoint(output, {
      complete: true,
      expectedTotal: 2,
      passed: 2,
      provider: "sandbox-provider",
      results: [
        { caseId: "repo-clone", engine: "codex", passed: true, errors: [] },
        { caseId: "repo-clone", engine: "claude", passed: true, errors: [] },
      ],
      snapshot: "runtime-template",
      total: 2,
    });

    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      complete: true,
      expectedTotal: 2,
      passed: 2,
      total: 2,
    });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
