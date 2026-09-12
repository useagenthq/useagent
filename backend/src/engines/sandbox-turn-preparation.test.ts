import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function sandboxFixture(options: {
  readonly cloneFails?: boolean;
  readonly state?: "absent" | "reuse";
  readonly onCommand?: (command: string) => void | Promise<void>;
} = {}) {
  let deletes = 0;
  const sandbox = {
    id: "preparation-sandbox",
    providerKind: "cube",
    process: {
      async executeCommand(command: string) {
        await options.onCommand?.(command);
        if (command.includes("printf '%s\\n' \"/root/work\"")) {
          return { exitCode: 0, result: "/root/work" };
        }
        if (command.includes("echo state:absent") && !command.includes("git clone")) {
          return { exitCode: 0, result: `state:${options.state ?? "absent"}` };
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

function freshLease(sandbox: SandboxHandle) {
  return {
    ...retainedLease(sandbox),
    reused: false,
  };
}

describe("sandbox turn provider cleanup", () => {
  test("runs the unsupported-ACL fallback and stops on its first permission failure", async () => {
    for (const scenario of [
      { aclFailure: "unsupported", chownFailure: false, expectedExit: 0 },
      { aclFailure: "unsupported", chownFailure: true, expectedExit: 42 },
      { aclFailure: "permission", chownFailure: false, expectedExit: 1 },
      { aclFailure: "mixed", chownFailure: false, expectedExit: 1 },
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "useagent-workspace-owner-"));
      const workdir = join(root, "work");
      const tools = join(root, "tools");
      const calls = join(root, "calls");
      await mkdir(workdir);
      await mkdir(tools);
      await chmod(workdir, 0o700);
      await writeFile(join(tools, "id"), [
        "#!/bin/sh",
        'case "$1" in -u|-g) printf \'%s\\n\' 1000 ;; *) exit 2 ;; esac',
      ].join("\n"));
      await writeFile(join(tools, "setfacl"), [
        "#!/bin/sh",
        "for target do :; done",
        'case "$ACL_FAILURE" in',
        '  unsupported) printf \'setfacl: %s: Operation not supported\\n\' "$target" >&2 ;;',
        '  permission) printf \'setfacl: %s: Permission denied\\n\' "$target" >&2 ;;',
        '  mixed) printf \'setfacl: %s: Operation not supported\\nsetfacl: %s: Permission denied\\n\' "$target" "$target" >&2 ;;',
        "esac",
        "exit 1",
      ].join("\n"));
      await writeFile(join(tools, "chown"), [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${calls}'`,
        '[ "$CHOWN_FAIL" = 1 ] && exit 42',
        "exit 0",
      ].join("\n"));
      await writeFile(join(tools, "stat"), [
        "#!/bin/sh",
        "for path do :; done",
        'if [ "$path" = "$FIXTURE_ROOT" ]; then printf \'%s\\n\' 0:1000:710; else printf \'%s\\n\' 0:0:1777; fi',
      ].join("\n"));
      await writeFile(join(tools, "realpath"), [
        "#!/bin/sh",
        "for path do :; done",
        'printf \'%s\\n\' "$path"',
      ].join("\n"));
      await writeFile(join(tools, "chmod"), [
        "#!/bin/sh",
        "mode=$1",
        "shift",
        '[ "$1" = -- ] && shift',
        '/bin/chmod "$mode" "$1"',
      ].join("\n"));
      await Promise.all(["id", "setfacl", "chown", "stat", "realpath", "chmod"].map((name) =>
        chmod(join(tools, name), 0o755)
      ));
      const retained = sandboxFixture();
      let activations = 0;
      const ownerResult: { exitCode: number | null; error: string } = {
        exitCode: null,
        error: "",
      };
      retained.sandbox.process.executeCommand = async (command: string) => {
        if (command.includes("printf '%s\\n' \"/root/work\"")) {
          return { exitCode: 0, result: "/root/work" };
        }
        if (!command.includes("ACL_ERROR=$(mktemp)")) return { exitCode: 0, result: "" };
        const result = Bun.spawnSync(["bash", "-c", command.replaceAll("/root", root)], {
          env: {
            ...process.env,
            PATH: `${tools}:${process.env.PATH ?? ""}`,
            FIXTURE_ROOT: root,
            ACL_FAILURE: scenario.aclFailure,
            CHOWN_FAIL: scenario.chownFailure ? "1" : "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        ownerResult.exitCode = result.exitCode;
        ownerResult.error = result.stderr.toString();
        return {
          exitCode: result.exitCode,
          result: result.stderr.toString(),
        };
      };

      try {
        const preparation = prepareSandboxTurn(
          context(),
          {
            snapshot: "runtime",
            chip: "runtime:claude",
            timingPrefix: "runtime",
            resourceUser: { uid: 1000, gid: 1000, home: "/home/user" },
            async prepareProvider() {
              activations += 1;
              return {};
            },
          },
          { acquireThreadSandbox: async () => retainedLease(retained.sandbox) },
        );
        if (scenario.expectedExit !== 0) {
          await expect(preparation).rejects.toThrow(
            "failed to prepare lower-privilege workspace owner",
          );
          expect(ownerResult.exitCode).toBe(scenario.expectedExit);
          expect(activations).toBe(0);
          expect((await stat(workdir)).mode & 0o7777).toBe(0o700);
        } else {
          const outcome = await preparation.then(() => "resolved", (error) => String(error));
          expect({ outcome, ownerResult }).toEqual({
            outcome: "resolved",
            ownerResult: { exitCode: 0, error: "" },
          });
          expect(activations).toBe(1);
          expect((await stat(root)).mode & 0o7777).toBe(0o710);
          expect((await stat(workdir)).mode & 0o7777).toBe(0o1777);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("runs the retained-sandbox fence before repository and input preparation", async () => {
    const order: string[] = [];
    const retained = sandboxFixture({
      onCommand(command) {
        if (command.includes("echo state:absent") && !command.includes("git clone")) {
          order.push("resources");
        }
      },
    });

    await prepareSandboxTurn(
      context(["useagenthq/useagent"]),
      {
        snapshot: "runtime",
        chip: "pi",
        timingPrefix: "pi",
        async prepareSandbox() {
          order.push("fence");
        },
        async prepareProvider() {
          order.push("provider");
          return {};
        },
      },
      { acquireThreadSandbox: async () => retainedLease(retained.sandbox) },
    );

    expect(order[0]).toBe("fence");
    expect(order).toContain("resources");
  });

  test("finishes fresh stable setup and slow resources before run-bound activation", async () => {
    const order: string[] = [];
    let stableProviderPrepared: boolean | undefined;
    const fresh = sandboxFixture({
      async onCommand(command) {
        if (command.includes("echo state:absent") && !command.includes("git clone")) {
          order.push("resources:start");
          await Bun.sleep(5);
          order.push("resources:end");
        }
      },
    });

    await prepareSandboxTurn(
      context(["useagenthq/useagent"]),
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareStableProvider() {
          order.push("stable:start");
          await Bun.sleep(5);
          order.push("stable:end");
        },
        async prepareProvider(_sandbox, _workdir, _binding, preparation) {
          stableProviderPrepared = preparation.stableProviderPrepared;
          order.push("activation");
          return {};
        },
      },
      { acquireThreadSandbox: async () => freshLease(fresh.sandbox) },
    );

    expect(order).toEqual([
      "stable:start",
      "stable:end",
      "resources:start",
      "resources:end",
      "activation",
    ]);
    expect(stableProviderPrepared).toBe(true);
  });

  test("retained repository validation keeps its existing overlap with provider setup", async () => {
    const order: string[] = [];
    let stableProviderPrepared: boolean | undefined;
    const repoValidated = Promise.withResolvers<void>();
    const retained = sandboxFixture({
      state: "reuse",
      onCommand(command) {
        if (command.includes("echo state:absent") && !command.includes("git clone")) {
          order.push("repo:identity");
          repoValidated.resolve();
        }
      },
    });

    await prepareSandboxTurn(
      context(["useagenthq/useagent"]),
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareProvider(_sandbox, _workdir, _binding, preparation) {
          stableProviderPrepared = preparation.stableProviderPrepared;
          order.push("provider:start");
          await repoValidated.promise;
          order.push("provider:end");
          return {};
        },
      },
      { acquireThreadSandbox: async () => retainedLease(retained.sandbox) },
    );

    expect(order).toEqual(["provider:start", "repo:identity", "provider:end"]);
    expect(stableProviderPrepared).toBe(false);
  });

  test("explicit resources-first providers keep their ordering on a fresh sandbox", async () => {
    const order: string[] = [];
    const fresh = sandboxFixture({
      onCommand(command) {
        if (command.includes("echo state:absent") && !command.includes("git clone")) {
          order.push("repo:identity");
        }
      },
    });

    await prepareSandboxTurn(
      context(["useagenthq/useagent"]),
      {
        snapshot: "runtime",
        chip: "runtime:claude",
        timingPrefix: "runtime",
        providerAfterResources: true,
        async prepareStableProvider() {
          order.push("stable");
        },
        async prepareProvider() {
          order.push("provider");
          return {};
        },
      },
      { acquireThreadSandbox: async () => freshLease(fresh.sandbox) },
    );

    expect(order).toEqual(["stable", "repo:identity", "provider"]);
  });

  test("resource failure after fresh stable setup creates no activation lease", async () => {
    const fresh = sandboxFixture({ cloneFails: true });
    let activations = 0;
    let closes = 0;

    const preparation = prepareSandboxTurn(
      context(["useagenthq/useagent"]),
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareStableProvider() {},
        async prepareProvider() {
          activations += 1;
          return {
            close: async () => {
              closes += 1;
              throw new Error("provider close failed");
            },
          };
        },
        closeProvider: (state) => state.close(),
      },
      { acquireThreadSandbox: async () => freshLease(fresh.sandbox) },
    );

    await expect(preparation).rejects.toThrow("failed to clone");
    expect(activations).toBe(0);
    expect(closes).toBe(0);
    expect(fresh.deletes()).toBe(0);
  });

  test("retained resource failure closes an overlapping activation exactly once", async () => {
    const retained = sandboxFixture({ cloneFails: true });
    let closes = 0;

    const preparation = prepareSandboxTurn(
      context(["useagenthq/useagent"]),
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareProvider() {
          await Bun.sleep(5);
          return {};
        },
        async closeProvider() {
          closes += 1;
        },
      },
      { acquireThreadSandbox: async () => retainedLease(retained.sandbox) },
    );

    await expect(preparation).rejects.toThrow("failed to clone");
    expect(closes).toBe(1);
    expect(retained.deletes()).toBe(0);
  });

  test("stable setup failure starts no fresh resource writes or activation", async () => {
    let resourceCommands = 0;
    let activations = 0;
    const fresh = sandboxFixture({
      onCommand(command) {
        if (command.includes("echo state:absent") || command.includes("git clone")) {
          resourceCommands += 1;
        }
      },
    });
    let closes = 0;

    const preparation = prepareSandboxTurn(
      context(["useagenthq/useagent"]),
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareStableProvider() {
          throw new Error("stable provider setup failed");
        },
        async prepareProvider() {
          activations += 1;
          return {};
        },
        closeProvider: async () => { closes += 1; },
      },
      { acquireThreadSandbox: async () => freshLease(fresh.sandbox) },
    );

    await expect(preparation).rejects.toThrow("stable provider setup failed");
    expect(activations).toBe(0);
    expect(closes).toBe(0);
    expect(resourceCommands).toBe(0);
    expect(fresh.deletes()).toBe(0);
  });

  test("fresh stable cancellation writes no inputs and creates no activation lease", async () => {
    const controller = new AbortController();
    const cancelled = new Error("run cancelled after provider setup");
    let inputCommands = 0;
    let uploads = 0;
    let activations = 0;
    let closes = 0;
    const fresh = sandboxFixture({
      onCommand(command) {
        if (command.includes(".skynet-inputs")) inputCommands += 1;
      },
    });
    fresh.sandbox.fs.uploadFile = async () => { uploads += 1; };
    const ctx = context();
    ctx.signal = controller.signal;
    ctx.inputFiles = [{
      id: "input-1",
      name: "brief.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      sha256: "0".repeat(64),
      storageKey: "run/input-1",
      sandboxPath: "/root/work/.skynet-inputs/input-1-brief.txt",
    }];

    await expect(prepareSandboxTurn(
      ctx,
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareStableProvider() {
          controller.abort(cancelled);
        },
        async prepareProvider() {
          activations += 1;
          return {};
        },
        async closeProvider() {
          closes += 1;
        },
      },
      { acquireThreadSandbox: async () => freshLease(fresh.sandbox) },
    )).rejects.toBe(cancelled);

    expect(inputCommands).toBe(0);
    expect(uploads).toBe(0);
    expect(activations).toBe(0);
    expect(closes).toBe(0);
  });

  test("fresh resource cancellation creates no run-bound activation lease", async () => {
    const controller = new AbortController();
    const cancelled = new Error("run cancelled during resources");
    let activations = 0;
    let closes = 0;
    const fresh = sandboxFixture({
      state: "reuse",
      onCommand(command) {
        if (command.includes("echo state:absent") && !command.includes("git clone")) {
          controller.abort(cancelled);
        }
      },
    });
    const ctx = context(["useagenthq/useagent"]);
    ctx.signal = controller.signal;

    await expect(prepareSandboxTurn(
      ctx,
      {
        snapshot: "runtime",
        chip: "runtime:codex",
        timingPrefix: "runtime",
        async prepareStableProvider() {},
        async prepareProvider() {
          activations += 1;
          return {};
        },
        async closeProvider() {
          closes += 1;
        },
      },
      { acquireThreadSandbox: async () => freshLease(fresh.sandbox) },
    )).rejects.toBe(cancelled);

    expect(activations).toBe(0);
    expect(closes).toBe(0);
  });
});
