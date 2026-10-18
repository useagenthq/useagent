import { describe, expect, test } from "bun:test";
import "./helpers";
import {
  discoverTurnOutputs,
  recordOutputBaseline,
  TurnOutputListingFailed,
  TurnOutputListingUnavailable,
  type DiscoveryDependencies,
} from "../src/artifacts/harvest";
import { createRun, getRun, setRunSandbox } from "../src/runs/repo";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { DEV_ORG_ID } from "../src/seed";

const complete = (records = "") => `${records}__USEAGENT_LISTING_COMPLETE__\0`;

async function sandboxRun(): Promise<NonNullable<Awaited<ReturnType<typeof getRun>>>> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "make a report",
    model: "m",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  await setRunSandbox(runId, `sb-${runId}`, { kind: "daytona", credential: "env" });
  return (await getRun(runId))!;
}

function clockSandbox(id: string, timestamps: string[]): SandboxHandle {
  return {
    id,
    process: {
      async executeCommand(command: string) {
        expect(command).toBe("date +%s.%N");
        return { exitCode: 0, result: timestamps.shift() };
      },
    },
  } as SandboxHandle;
}

describe("automatic artifact discovery", () => {
  test("uses the immutable first sandbox-clock baseline and returns candidates only", async () => {
    const run = await sandboxRun();
    const sandbox = clockSandbox(run.sandboxId!, ["1757000000.100000000\n", "1757000001.200000000\n"]);
    await recordOutputBaseline(run.id, sandbox, "/root/work");
    await recordOutputBaseline(run.id, sandbox, "/root/work");

    const commands: string[] = [];
    const deps: DiscoveryDependencies = {
      list: async (_run, command) => {
        commands.push(command);
        return command.includes("-name .git")
          ? complete("/root/work/repo\0")
          : complete("12\t/root/work/report.txt\0" + "9\t/root/work/repo/code.json\0");
      },
    };
    expect(await discoverTurnOutputs(run, {}, deps)).toEqual({
      candidates: [{ path: "/root/work/report.txt", size: 12 }],
      withheldPaths: [],
      truncated: false,
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("-newerct '@1757000000.100000000'");
  });

  test("returns no automatic candidates without a baseline and never lists", async () => {
    const run = await sandboxRun();
    let listed = false;
    expect(await discoverTurnOutputs(run, {}, {
      list: async () => {
        listed = true;
        return complete();
      },
    })).toEqual({ candidates: [], withheldPaths: [], truncated: false });
    expect(listed).toBe(false);
  });

  test("a project tree past the cap falls back to the workspace's top-level files", async () => {
    // Prod 2026-10-11: a Tauri project changed 500+ json/png/md files and the
    // finished run failed with "Artifact delivery failed".
    const run = await sandboxRun();
    await recordOutputBaseline(run.id, clockSandbox(run.sandboxId!, ["1757000000.3"]), "/root/work");
    const tree = Array.from({ length: 30 }, (_, index) => `10\t/root/work/app/src/icon-${index}.png\0`).join("");
    const commands: string[] = [];
    const deps: DiscoveryDependencies = {
      list: async (_run, command) => {
        commands.push(command);
        if (command.includes("-name .git")) return complete();
        return command.includes("-maxdepth 1")
          ? complete("40\t/root/work/app-source-r15.zip\0")
          : complete(tree + "40\t/root/work/app-source-r15.zip\0");
      },
    };
    expect(await discoverTurnOutputs(run, {}, deps)).toEqual({
      candidates: [{ path: "/root/work/app-source-r15.zip", size: 40 }],
      withheldPaths: [],
      truncated: true,
    });
    expect(commands).toHaveLength(3);

    const crowded = Array.from({ length: 30 }, (_, index) => `10\t/root/work/out-${index}.png\0`).join("");
    expect(await discoverTurnOutputs(run, {}, {
      list: async (_run, command) => command.includes("-name .git") ? complete() : complete(crowded),
    })).toEqual({ candidates: [], withheldPaths: [], truncated: true });

    // Thousands of unchanged repository markers say nothing about changed files.
    const markers = Array.from({ length: 3001 }, (_, index) => `/root/work/vendor/repo-${index}\0`).join("");
    expect(await discoverTurnOutputs(run, {}, {
      list: async (_run, command) => command.includes("-name .git")
        ? complete(markers)
        : complete("40\t/root/work/notes.md\0"),
    })).toEqual({ candidates: [{ path: "/root/work/notes.md", size: 40 }], withheldPaths: [], truncated: false });
  });

  test("throws on baseline binding mismatch and listing failure", async () => {
    const run = await sandboxRun();
    await recordOutputBaseline(run.id, clockSandbox(run.sandboxId!, ["1757000000.1"]), "/root/work");
    await setRunSandbox(run.id, `replacement-${run.id}`, { kind: "daytona", credential: "env" });
    const rebound = (await getRun(run.id))!;
    await expect(discoverTurnOutputs(rebound, {}, {
      list: async () => complete(),
    })).rejects.toThrow("sandbox mismatch");

    const current = await sandboxRun();
    await recordOutputBaseline(current.id, clockSandbox(current.sandboxId!, ["1757000000.2"]), "/root/work");
    await expect(discoverTurnOutputs(current, {}, {
      list: async () => "",
    })).rejects.toThrow("incomplete");
  });

  test("repeats a dropped listing and gives up after the retries", async () => {
    const run = await sandboxRun();
    await recordOutputBaseline(run.id, clockSandbox(run.sandboxId!, ["1757000000.4"]), "/root/work");
    let calls = 0;
    expect(await discoverTurnOutputs(run, {}, {
      retryDelaysMs: [0, 0],
      list: async (_run, command) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("2: connection reset"), { name: "SandboxError" });
        return command.includes("-name .git") ? complete() : complete("5\t/root/work/out.md\0");
      },
    })).toEqual({ candidates: [{ path: "/root/work/out.md", size: 5 }], withheldPaths: [], truncated: false });
    expect(calls).toBe(3);

    let attempts = 0;
    await expect(discoverTurnOutputs(run, {}, {
      retryDelaysMs: [0, 0],
      list: async () => {
        attempts += 1;
        throw Object.assign(new Error("14: sandbox unreachable"), { name: "SandboxError" });
      },
    })).rejects.toBeInstanceOf(TurnOutputListingUnavailable);
    expect(attempts).toBe(3);

    // A listing that ran and exited non-zero is an answer: not repeated, not a drop.
    let answered = 0;
    await expect(discoverTurnOutputs(run, {}, {
      retryDelaysMs: [0, 0],
      list: async () => {
        answered += 1;
        throw new TurnOutputListingFailed("artifact listing command failed");
      },
    })).rejects.toBeInstanceOf(TurnOutputListingFailed);
    expect(answered).toBe(1);

    // So is a provider refusing or truncating the result (Box: command_output_truncated).
    let truncated = 0;
    await expect(discoverTurnOutputs(run, {}, {
      retryDelaysMs: [0, 0],
      list: async () => {
        truncated += 1;
        throw Object.assign(new Error("command_output_truncated"), { name: "BoxApiError" });
      },
    })).rejects.toBeInstanceOf(TurnOutputListingFailed);
    expect(truncated).toBe(1);
  });

  test("honors cancellation before invoking sandbox work", async () => {
    const run = await sandboxRun();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let executed = false;
    const sandbox = {
      id: run.sandboxId!,
      process: {
        async executeCommand() {
          executed = true;
          return { exitCode: 0, result: "1757000000.3" };
        },
      },
    } as SandboxHandle;
    await expect(recordOutputBaseline(run.id, sandbox, "/root/work", controller.signal))
      .rejects.toThrow("cancelled");
    expect(executed).toBe(false);
  });
});
