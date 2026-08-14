import { describe, expect, test } from "bun:test";
import {
  parseArtifactReclaimArgs,
  runArtifactReclaimCli,
} from "./reclaim-cli";

describe("artifact reclaim CLI", () => {
  test("parses dry-run and age without requiring a live filesystem delete", () => {
    expect(parseArtifactReclaimArgs(["--dry-run", "--min-age-hours", "0"])).toEqual({
      dryRun: true,
      minAgeMs: 0,
    });
  });

  test("passes dry-run to the reclamation boundary and emits machine-readable output", async () => {
    const lines: string[] = [];
    await runArtifactReclaimCli(
      ["--dry-run", "--min-age-hours", "2"],
      (line) => lines.push(line),
      async (options) => {
        expect(options).toEqual({ dryRun: true, minAgeMs: 2 * 60 * 60 * 1000 });
        return { scanned: 2, removed: ["a".repeat(64)], retained: ["b".repeat(64)] };
      },
    );

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      dry_run: true,
      scanned: 2,
      removed_count: 1,
      removed: ["a".repeat(64)],
      retained_count: 1,
    });
  });
});
