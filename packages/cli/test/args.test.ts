import { describe, expect, test } from "bun:test";
import { MAX_FLEET_CONCURRENCY } from "@useagent/agent-client/fleet";
import { CliError } from "../src/errors";
import { parseFanArgs, parseRunArgs, parseStatusArgs } from "../src/args";

describe("parseRunArgs", () => {
  test("reads the prompt plus engine/model/repeatable repo/watch", () => {
    const args = parseRunArgs([
      "do the thing",
      "--engine",
      "codex",
      "--model",
      "openai/gpt-5.6",
      "--repo",
      "acme/web",
      "--repo",
      "acme/api",
      "--watch",
    ]);
    expect(args).toEqual({
      prompt: "do the thing",
      engine: "codex",
      model: "openai/gpt-5.6",
      repos: ["acme/web", "acme/api"],
      watch: true,
    });
  });

  test("supports --flag=value and defaults watch to false", () => {
    const args = parseRunArgs(["hi", "--engine=claude"]);
    expect(args.engine).toBe("claude");
    expect(args.watch).toBe(false);
    expect(args.repos).toEqual([]);
  });

  test("throws on a missing prompt", () => {
    expect(() => parseRunArgs(["--engine", "codex"])).toThrow(CliError);
  });

  test("throws on an unknown flag and on a value flag given twice", () => {
    expect(() => parseRunArgs(["hi", "--bogus"])).toThrow(/unknown flag/);
    expect(() => parseRunArgs(["hi", "--engine", "a", "--engine", "b"])).toThrow(/only once/);
  });

  test("throws when a value flag has no value", () => {
    expect(() => parseRunArgs(["hi", "--engine"])).toThrow(/needs a value/);
  });
});

describe("parseFanArgs", () => {
  test("defaults parallel to 6 and reads qc/out", () => {
    const args = parseFanArgs(["tasks.jsonl", "--qc", "check it", "--out", "results.jsonl"]);
    expect(args).toEqual({ file: "tasks.jsonl", parallel: 6, qc: "check it", out: "results.jsonl" });
  });

  test("rejects parallelism above the fleet safety bound", () => {
    expect(() =>
      parseFanArgs(["tasks.jsonl", "--parallel", String(MAX_FLEET_CONCURRENCY + 1)]),
    ).toThrow(`between 1 and ${MAX_FLEET_CONCURRENCY}`);
  });

  test("parses a positive --parallel and rejects non-positive/non-integer", () => {
    expect(parseFanArgs(["t.jsonl", "--parallel", "3"]).parallel).toBe(3);
    expect(() => parseFanArgs(["t.jsonl", "--parallel", "0"])).toThrow(/integer between/);
    expect(() => parseFanArgs(["t.jsonl", "--parallel", "x"])).toThrow(/integer between/);
  });

  test("requires exactly one tasks file", () => {
    expect(() => parseFanArgs([])).toThrow(/needs a tasks file/);
    expect(() => parseFanArgs(["a.jsonl", "b.jsonl"])).toThrow(/single tasks file/);
  });
});

describe("parseStatusArgs", () => {
  test("reads a single run id", () => {
    expect(parseStatusArgs(["run_1"])).toEqual({ runId: "run_1" });
  });
  test("requires exactly one run id", () => {
    expect(() => parseStatusArgs([])).toThrow(/needs a run id/);
    expect(() => parseStatusArgs(["a", "b"])).toThrow(/single run id/);
  });
});
