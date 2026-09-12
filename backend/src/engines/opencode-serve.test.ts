import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SandboxHandle } from "@useagent/sandbox-contract";
import {
  OPENCODE_VERSION,
  ensureServer,
  opencodeLauncherFor,
  probeOpencodeLauncher,
} from "./opencode-serve";
import type { EmitStep } from "./types";

interface FakeSandbox extends SandboxHandle {
  readonly commands: string[];
  readonly sessionCommands: string[];
  readonly deletedSessions: number;
}

/** A sandbox whose `opencode --version` probe answers as configured and whose serve session is recorded. */
function fakeSandbox(options: { probe?: string | Error; home?: string } = {}): FakeSandbox {
  const commands: string[] = [];
  const sessionCommands: string[] = [];
  const state = { deletedSessions: 0 };
  const sandbox = {
    id: "sbx-1",
    cpu: 2,
    memory: 8,
    commands,
    sessionCommands,
    get deletedSessions() {
      return state.deletedSessions;
    },
    process: {
      async executeCommand(command: string) {
        commands.push(command);
        if (command.includes('printf %s "$HOME"')) return { exitCode: 0, result: options.home ?? "/home/user" };
        if (options.probe instanceof Error) throw options.probe;
        return { exitCode: 0, result: options.probe ?? "OK" };
      },
      async createSession() {},
      async deleteSession() {
        state.deletedSessions += 1;
      },
      async getSession() {
        return { commands: [] };
      },
      async executeSessionCommand(_session: string, request: { command: string }) {
        sessionCommands.push(request.command);
        return { cmdId: "c1", exitCode: 0 };
      },
      async getSessionCommandLogs() {
        return { output: "" };
      },
      async createPty() {
        throw new Error("unused");
      },
    },
    fs: {} as SandboxHandle["fs"],
    async start() {},
    async delete() {},
    async getPreviewLink() {
      return { url: "https://4096-sbx-1.example.test", token: "t", headers: { "x-daytona-preview-token": "t" } };
    },
  };
  return sandbox as unknown as FakeSandbox;
}

/** Health answers in order; the last one repeats. */
function healthSequence(statuses: number[]): { calls: number } {
  const seen = { calls: 0 };
  spyOn(globalThis, "fetch").mockImplementation((async () => {
    const status = statuses[Math.min(seen.calls, statuses.length - 1)] ?? 503;
    seen.calls += 1;
    return new Response(null, { status });
  }) as unknown as typeof fetch);
  return seen;
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("opencode launcher probe", () => {
  test("a working preinstalled opencode is used directly", async () => {
    expect(await probeOpencodeLauncher(fakeSandbox({ probe: "OK" }))).toEqual({ npx: false, reason: null });
  });

  test("a launcher that hangs on --version (Box's self-referencing shim) takes the npx bootstrap", async () => {
    const launcher = await probeOpencodeLauncher(fakeSandbox({ probe: "HUNG" }));
    expect(launcher.npx).toBe(true);
    expect(launcher.reason).toMatch(/does not answer --version within 8s/);
  });

  test("a sandbox with no opencode at all takes the npx bootstrap", async () => {
    const launcher = await probeOpencodeLauncher(fakeSandbox({ probe: "MISSING" }));
    expect(launcher).toEqual({ npx: true, reason: "no opencode binary is installed in this sandbox" });
  });

  test("a probe that cannot run is not trusted either", async () => {
    const launcher = await probeOpencodeLauncher(fakeSandbox({ probe: new Error("exec 408") }));
    expect(launcher.npx).toBe(true);
    expect(launcher.reason).toContain("exec 408");
  });

  test("the per-turn launcher probes once and announces the npx path in the timeline", async () => {
    const steps: EmitStep[] = [];
    const sandbox = fakeSandbox({ probe: "HUNG" });
    const launcher = opencodeLauncherFor(sandbox, { emit: async (step) => { steps.push(step); return undefined; } }, { baseImage: false });
    expect((await launcher()).npx).toBe(true);
    expect((await launcher()).npx).toBe(true);
    expect(sandbox.commands.filter((command) => command.includes("opencode --version"))).toHaveLength(1);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.label).toBe(
      `Bootstrapping opencode-ai@${OPENCODE_VERSION} with npx: the preinstalled opencode does not answer --version within 8s (a broken launcher shim)`,
    );
    expect(steps[0]?.chip).toBe("warning");
  });

  test("a base-image sandbox skips the probe and goes straight to npx", async () => {
    const steps: EmitStep[] = [];
    const sandbox = fakeSandbox({ probe: "OK" });
    const launcher = opencodeLauncherFor(sandbox, { emit: async (step) => { steps.push(step); return undefined; } }, { baseImage: true });
    expect((await launcher()).npx).toBe(true);
    expect(sandbox.commands).toEqual([]);
    expect(steps[0]?.label).toContain("the sandbox started from the provider's base image");
  });
});

describe("ensureServer", () => {
  const signal = new AbortController().signal;

  test("a healthy resident server is reused without starting anything", async () => {
    healthSequence([200]);
    const sandbox = fakeSandbox();
    const server = await ensureServer(sandbox, async () => ({ npx: false, reason: null }), signal, ":");
    expect(server.workdir).toBe("/home/user/work");
    expect(sandbox.sessionCommands).toEqual([]);
    expect(sandbox.deletedSessions).toBe(0);
  });

  test("a healthy resident server is relaunched when the caller needs a fresh environment", async () => {
    // healthy -> stopped after the session delete -> serving again after relaunch
    healthSequence([200, 503, 200]);
    const sandbox = fakeSandbox();
    await ensureServer(sandbox, async () => ({ npx: false, reason: null }), signal, '. "$HOME/.skynet/secrets/skynet-env.sh"', {
      restart: true,
    });
    expect(sandbox.deletedSessions).toBeGreaterThanOrEqual(1);
    expect(sandbox.sessionCommands).toHaveLength(1);
    expect(sandbox.sessionCommands[0]).toBe(
      '. "$HOME/.skynet/secrets/skynet-env.sh" && cd \'/home/user/work\' && exec opencode serve --hostname 0.0.0.0 --port 4096',
    );
  });

  test("a stopped server boots through the launcher the probe chose", async () => {
    healthSequence([503, 200]);
    const sandbox = fakeSandbox();
    await ensureServer(sandbox, async () => ({ npx: true, reason: "shim" }), signal, ":");
    expect(sandbox.sessionCommands[0]).toContain(`exec npx -y opencode-ai@${OPENCODE_VERSION} serve`);
  });
});
