import { describe, expect, test } from "bun:test";
import type { SandboxBinding } from "../sandboxes/binding";
import type { SandboxHandle } from "../sandboxes/provider";
import type { EngineRunContext } from "./types";
import { prepareSandboxTurn } from "./sandbox-turn-preparation";

const binding = { kind: "cube" } as SandboxBinding;

function context(repos: string[] = []): EngineRunContext {
  return {
    runId: "run-preparation",
    threadId: "thread-preparation",
    orgId: null,
    userId: null,
    model: "gpt-5.6-luna",
    prompt: "work",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/root/work",
    repos,
    resolvedResources: [],
    inputFiles: [],
    signal: new AbortController().signal,
    async emit() {
      return undefined;
    },
    setSummary() {},
  } as EngineRunContext;
}

function retainedSandbox(options: { readonly cloneFails?: boolean } = {}) {
  let deletes = 0;
  const sandbox = {
    id: "retained-sandbox",
    providerKind: "cube",
    process: {
      async executeCommand(command: string) {
        if (command.includes("printf '%s\\n' \"/root/work\"")) {
          return { exitCode: 0, result: "/root/work" };
        }
        if (command.includes("echo state:absent") && !command.includes("git clone")) {
          return { exitCode: 0, result: "state:absent" };
        }
        if (command.includes("git clone")) {
          return options.cloneFails
            ? { exitCode: 1, result: "clone failed" }
            : { exitCode: 0, result: "clone:ok" };
        }
        return { exitCode: 0, result: "" };
      },
    },
    fs: {
      async uploadFile() {},
    },
    async delete() {
      deletes += 1;
    },
  } as unknown as SandboxHandle;
  return { sandbox, deletes: () => deletes };
}

function retainedLease(sandbox: SandboxHandle) {
  return {
    sandbox,
    binding,
    reused: true,
    retained: true,
    releaseAfterRun: false,
  };
}

describe("sandbox turn provider cleanup", () => {
  test("closes a late provider lease once when retained-sandbox resources fail", async () => {
    const retained = retainedSandbox({ cloneFails: true });
    let closes = 0;

    const preparation = prepareSandboxTurn(
      context(["useagenthq/useagent"]),
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareProvider() {
          await Bun.sleep(10);
          return {
            close: async () => {
              closes += 1;
              throw new Error("provider close failed");
            },
          };
        },
        closeProvider: (state) => state.close(),
      },
      { acquireThreadSandbox: async () => retainedLease(retained.sandbox) },
    );

    await expect(preparation).rejects.toThrow("failed to clone");
    expect(closes).toBe(1);
    expect(retained.deletes()).toBe(0);
  });

  test("does not invent cleanup state when provider preparation fails", async () => {
    const retained = retainedSandbox();
    let closes = 0;

    const preparation = prepareSandboxTurn(
      context(),
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareProvider(): Promise<{ close(): Promise<void> }> {
          throw new Error("provider preparation failed");
        },
        closeProvider: async () => { closes += 1; },
      },
      { acquireThreadSandbox: async () => retainedLease(retained.sandbox) },
    );

    await expect(preparation).rejects.toThrow("provider preparation failed");
    expect(closes).toBe(0);
    expect(retained.deletes()).toBe(0);
  });
});
