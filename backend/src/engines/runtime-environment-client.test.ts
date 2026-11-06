import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  buildRuntimeEnvironmentFirstAccessCommand,
  buildRuntimeEnvironmentAuthenticationCommand,
  buildRuntimeEnvironmentProtocolProbeCommand,
  buildRuntimeEnvironmentRequestCommand,
  buildRuntimeEnvironmentSessionProbeCommand,
  buildRuntimeEnvironmentWebSocketTicketCommand,
  decodeRuntimeEnvironmentCommandOutput,
  invalidateRuntimeEnvironmentAccess,
  issueRuntimeEnvironmentWebSocketTicket,
  prewarmRuntimeEnvironmentAccess,
  requestRuntimeEnvironment,
  runtimeEnvironmentAccessValidated,
  RuntimeEnvironmentRequestError,
  setRuntimeArtifactVerificationsForTest,
} from "./runtime-environment-client";
import { buildRuntimeEnvironmentReadinessCommand, RUNTIME_GENERATION } from "./runtime-environment";
import { buildNativeRuntimeArtifactProbe } from "./native-runtime-artifact";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const ROOT_LAYOUT = {
  home: "/root",
  workdir: "/root/work",
  runsAsRoot: true,
} as const;
const BOX_LAYOUT = {
  home: "/home/user",
  workdir: "/home/user/work",
  runsAsRoot: false,
  bunExecutable: "/usr/local/bin/bun",
} as const;

// Artifact verifications this process "persisted", per test: a fresh backend
// knows none, so first accesses run the artifact probe unless a test says so.
let verifiedArtifacts = new Set<string>();
beforeEach(() => {
  verifiedArtifacts = new Set();
  setRuntimeArtifactVerificationsForTest({
    verified: async (sandboxId, generation) => verifiedArtifacts.has(`${sandboxId}:${generation}`),
    record: async (sandboxId, generation) => void verifiedArtifacts.add(`${sandboxId}:${generation}`),
  });
});
afterEach(() => setRuntimeArtifactVerificationsForTest(null));

describe("T3 environment client", () => {
  test("a sandbox an earlier backend process verified skips the artifact probe on first access", async () => {
    const request = { method: "GET", path: "/api/orchestration/shell" } as const;
    const harness = (id: string) => {
      const commands: string[] = [];
      const sandbox = {
        id,
        process: {
          executeCommand: async (command: string) => {
            commands.push(command);
            return { exitCode: 0, result: '{"projects":[],"threads":[]}\n__USEAGENT_T3_HTTP_STATUS__:200' };
          },
        },
      } as unknown as SandboxHandle;
      return { sandbox, commands };
    };

    // First time: the probe runs in the first-access command and its pass is recorded.
    const fresh = harness("cube-t3-artifact-fresh");
    await requestRuntimeEnvironment(fresh.sandbox, request, new AbortController().signal);
    expect(fresh.commands[0]).toBe(buildRuntimeEnvironmentFirstAccessCommand(request, ROOT_LAYOUT));
    expect(fresh.commands[0]).toContain("# native-runtime-verified");
    expect(verifiedArtifacts.has(`cube-t3-artifact-fresh:${RUNTIME_GENERATION}`)).toBe(true);

    // After a backend restart (no access cached), a recorded sandbox skips only the probe.
    verifiedArtifacts.add(`cube-t3-artifact-known:${RUNTIME_GENERATION}`);
    const known = harness("cube-t3-artifact-known");
    await requestRuntimeEnvironment(known.sandbox, request, new AbortController().signal);
    expect(known.commands).toHaveLength(1);
    expect(known.commands[0]).toBe(buildRuntimeEnvironmentFirstAccessCommand(request, ROOT_LAYOUT, true));
    expect(known.commands[0]).not.toContain("# native-runtime-verified");
    expect(known.commands[0]).toContain(buildRuntimeEnvironmentReadinessCommand());
    expect(known.commands[0]).toContain(buildRuntimeEnvironmentSessionProbeCommand());
    expect(runtimeEnvironmentAccessValidated(known.sandbox)).toBe(true);

    // A record for another generation proves nothing about this one.
    verifiedArtifacts.add("cube-t3-artifact-old:useagent-runtime-v0");
    const old = harness("cube-t3-artifact-old");
    await requestRuntimeEnvironment(old.sandbox, request, new AbortController().signal);
    expect(old.commands[0]).toContain("# native-runtime-verified");
  });

  test("decodes the bounded HTTP status marker for runtime and canary callers", () => {
    expect(decodeRuntimeEnvironmentCommandOutput([
      '{"projects":[],"threads":[]}',
      "__USEAGENT_T3_HTTP_STATUS__:200",
    ].join("\n"))).toEqual({
      body: '{"projects":[],"threads":[]}',
      status: 200,
    });
  });

  test("keeps the one-time pairing credential and cookie inside the sandbox", () => {
    const command = buildRuntimeEnvironmentAuthenticationCommand();

    expect(command).toContain(
      '"/root/.local/share/useagent/native-runtime/42ef3397fa38befec011b840c953adbff7c8770a/bin/t3" auth pairing create',
    );
    expect(command).not.toMatch(/(^|\s)t3 auth pairing create/);
    expect(command).toContain('--json >"$PAIRING"');
    expect(command).toContain("/api/auth/browser-session");
    expect(command).toContain("chmod 600");
    expect(command).toContain('rm -f "$PAIRING"');
    // The pairing replaces the jar in one rename; a concurrent pairing never sees it missing.
    expect(command).not.toContain('rm -f "$COOKIE"');
    expect(command).not.toContain("echo $PAIRING");
    expect(command).not.toContain("0.0.0.0");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("uses the resident native runtime artifact for Box authentication", () => {
    const command = buildRuntimeEnvironmentAuthenticationCommand(BOX_LAYOUT);

    expect(command).toContain(
      '"/home/user/.local/share/useagent/native-runtime/42ef3397fa38befec011b840c953adbff7c8770a/bin/t3" auth pairing create',
    );
    expect(command).not.toContain("/root");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("uses only the private loopback cookie for session checks", () => {
    const command = buildRuntimeEnvironmentSessionProbeCommand();

    expect(command).toContain("127.0.0.1:37733/api/auth/session");
    expect(command).toContain("session.cookies");
    expect(command).toContain("authenticated!==true");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("base64-encodes POST JSON instead of interpolating prompt text", () => {
    const hostile = `hello'; touch /tmp/not-allowed; #`;
    const command = buildRuntimeEnvironmentRequestCommand({
      method: "POST",
      path: "/api/projects/mutate",
      payload: { message: hostile },
    });

    expect(command).not.toContain(hostile);
    expect(command).toContain("base64 -d");
    expect(command).toContain("--data-binary @-");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("rejects invalid method and payload combinations", () => {
    expect(() =>
      buildRuntimeEnvironmentRequestCommand({
        method: "POST",
        path: "/api/projects/mutate",
      }),
    ).toThrow("requires a payload");
    expect(() =>
      buildRuntimeEnvironmentRequestCommand({
        method: "GET",
        path: "/api/orchestration/shell",
        payload: { unexpected: true },
      }),
    ).toThrow("does not accept a payload");
    expect(() =>
      buildRuntimeEnvironmentRequestCommand({
        method: "GET",
        path: "/api/orchestration/threads/thread-1;touch-/tmp/nope/bounded",
      }),
    ).toThrow("invalid runtime loopback path");
  });

  test("names the orchestration protocol on every request and reads threads through their bounded window", () => {
    const command = buildRuntimeEnvironmentRequestCommand({ method: "GET", path: "/api/orchestration/shell" });
    expect(command).toContain("-H 'x-t3-orchestration-protocol: 2'");
    expect(buildRuntimeEnvironmentRequestCommand({
      method: "GET", path: `/api/orchestration/threads/${SANDBOX_NAME_PREFIX}-thread-1/bounded`,
    })).toContain(`'http://127.0.0.1:37733/api/orchestration/threads/${SANDBOX_NAME_PREFIX}-thread-1/bounded'`);
    expect(() => buildRuntimeEnvironmentRequestCommand({
      method: "POST", path: "/api/orchestration/dispatch" as never, payload: {},
    })).toThrow("invalid runtime loopback path");
  });

  test("accepts only a runtime that speaks orchestration protocol 2", () => {
    const probe = buildRuntimeEnvironmentProtocolProbeCommand();
    expect(probe).toContain("127.0.0.1:37733/.well-known/t3/environment");
    expect(Bun.spawnSync(["bash", "-n", "-c", probe]).exitCode).toBe(0);
    const script = /node -e (".*")$/.exec(probe)?.[1];
    const check = (descriptor: unknown) => Bun.spawnSync(["node", "-e", JSON.parse(script!)], {
      stdin: new TextEncoder().encode(JSON.stringify(descriptor)),
    }).exitCode;
    expect(check({ orchestrationProtocolVersion: 2 })).toBe(0);
    expect(check({ orchestrationProtocolVersion: 1 })).toBe(1);
    expect(check({ label: "an older runtime" })).toBe(1);
  });

  test("fails access closed when the runtime is not protocol 2", async () => {
    const sandbox = {
      id: "cube-t3-protocol-1",
      process: {
        executeCommand: async (command: string) => {
          if (command === buildRuntimeEnvironmentProtocolProbeCommand()) return { exitCode: 1, result: "" };
          if (command.includes("/api/orchestration/shell") && command.includes(buildRuntimeEnvironmentProtocolProbeCommand())) {
            return { exitCode: 1, result: "" };
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;
    await expect(requestRuntimeEnvironment(
      sandbox, { method: "GET", path: "/api/orchestration/shell" }, new AbortController().signal,
    )).rejects.toThrow("does not speak orchestration protocol 2");
  });

  test("skips repeated readiness and auth probes after validated access", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "cube-t3-client",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentReadinessCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentSessionProbeCommand()) {
            return { exitCode: 0, result: "" };
          }
          return { exitCode: 0, result: '{"projects":[],"threads":[]}' };
        },
      },
    } as unknown as SandboxHandle;

    expect(runtimeEnvironmentAccessValidated(sandbox)).toBe(false);
    await expect(
      requestRuntimeEnvironment<{ projects: unknown[]; threads: unknown[] }>(
        sandbox,
        { method: "GET", path: "/api/orchestration/shell" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ projects: [], threads: [] });
    // A warm runtime: the adapter may read its shell alongside the provider bridge.
    expect(runtimeEnvironmentAccessValidated(sandbox)).toBe(true);
    await expect(
      requestRuntimeEnvironment<{ projects: unknown[]; threads: unknown[] }>(
        sandbox,
        { method: "GET", path: "/api/orchestration/shell" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ projects: [], threads: [] });
    expect(commands).toHaveLength(2);
    expect(commands).toEqual([
      buildRuntimeEnvironmentFirstAccessCommand(
        { method: "GET", path: "/api/orchestration/shell" },
        ROOT_LAYOUT,
      ),
      expect.stringContaining("/api/orchestration/shell"),
    ]);
    expect(Bun.spawnSync(["bash", "-n", "-c", commands[0]!]).exitCode).toBe(0);
    invalidateRuntimeEnvironmentAccess(sandbox);
    expect(runtimeEnvironmentAccessValidated(sandbox)).toBe(false);
  });

  test("falls back to the existing auth repair when the coalesced first access is stale", async () => {
    const commands: string[] = [];
    const request = { method: "GET", path: "/api/orchestration/shell" } as const;
    const firstAccess = buildRuntimeEnvironmentFirstAccessCommand(request, ROOT_LAYOUT);
    const sandbox = {
      id: "cube-t3-stale-first-access",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command === firstAccess) return { exitCode: 1, result: "" };
          if (command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentReadinessCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentSessionProbeCommand()) {
            return { exitCode: 1, result: "" };
          }
          if (command === buildRuntimeEnvironmentAuthenticationCommand()) {
            return { exitCode: 0, result: "" };
          }
          return {
            exitCode: 0,
            result: '{"projects":[],"threads":[]}\n__USEAGENT_T3_HTTP_STATUS__:200',
          };
        },
      },
    } as unknown as SandboxHandle;

    await expect(requestRuntimeEnvironment(sandbox, request, new AbortController().signal))
      .resolves.toEqual({ projects: [], threads: [] });
    expect(commands[0]).toBe(firstAccess);
    expect(commands).toContain(buildRuntimeEnvironmentAuthenticationCommand());
    expect(commands.at(-1)).toBe(buildRuntimeEnvironmentRequestCommand(request));
  });

  test("serializes coalesced first-access repair for concurrent callers", async () => {
    const commands: string[] = [];
    const request = { method: "GET", path: "/api/orchestration/shell" } as const;
    const firstAccess = buildRuntimeEnvironmentFirstAccessCommand(request, ROOT_LAYOUT);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sandbox = {
      id: "cube-t3-concurrent-first-access-repair",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command === firstAccess) {
            started.resolve();
            await release.promise;
            return { exitCode: 1, result: "" };
          }
          if (command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentReadinessCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentSessionProbeCommand()) {
            return { exitCode: 1, result: "" };
          }
          if (command === buildRuntimeEnvironmentAuthenticationCommand()) {
            return { exitCode: 0, result: "" };
          }
          return {
            exitCode: 0,
            result: '{"projects":[],"threads":[]}\n__USEAGENT_T3_HTTP_STATUS__:200',
          };
        },
      },
    } as unknown as SandboxHandle;

    const first = requestRuntimeEnvironment(sandbox, request, new AbortController().signal);
    await started.promise;
    const second = requestRuntimeEnvironment(sandbox, request, new AbortController().signal);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { projects: [], threads: [] },
      { projects: [], threads: [] },
    ]);

    expect(commands.filter((command) => command === firstAccess)).toHaveLength(1);
    // A ready runtime on this release's artifact is not checksummed again.
    expect(commands.filter((command) => command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)))
      .toHaveLength(0);
    expect(commands.filter((command) => command === buildRuntimeEnvironmentAuthenticationCommand()))
      .toHaveLength(1);
    expect(commands.filter((command) => command === buildRuntimeEnvironmentRequestCommand(request)))
      .toHaveLength(2);
  });

  test("bootstraps Box authentication with the same native runtime launcher", async () => {
    const commands: string[] = [];
    const request = { method: "GET", path: "/api/orchestration/shell" } as const;
    const firstAccess = buildRuntimeEnvironmentFirstAccessCommand(request, BOX_LAYOUT);
    const sandbox = {
      id: "cube-t3-auth-bootstrap",
      providerKind: "box",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command === firstAccess) return { exitCode: 1, result: "" };
          if (command === buildNativeRuntimeArtifactProbe(BOX_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentReadinessCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentSessionProbeCommand()) {
            return { exitCode: 1, result: "" };
          }
          if (command === buildRuntimeEnvironmentAuthenticationCommand(BOX_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          return { exitCode: 0, result: '{"projects":[]}' };
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      requestRuntimeEnvironment<{ projects: unknown[] }>(
        sandbox,
        request,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ projects: [] });
    expect(commands).toContain(buildRuntimeEnvironmentAuthenticationCommand(BOX_LAYOUT));
    expect(commands).toContain(buildRuntimeEnvironmentProtocolProbeCommand());
    expect(commands).toHaveLength(6);
    expect(commands[0]).toBe(firstAccess);
    expect(commands[1]).toBe(buildRuntimeEnvironmentReadinessCommand());
  });

  test("prewarms private access and makes one shell request so a claimed sandbox skips it", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "cube-t3-private-access",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentReadinessCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentSessionProbeCommand()) {
            return { exitCode: 1, result: "" };
          }
          if (command === buildRuntimeEnvironmentAuthenticationCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentProtocolProbeCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command.includes("/api/orchestration/shell")) {
            return { exitCode: 0, result: '{"projects":[],"threads":[]}' };
          }
          throw new Error("unexpected orchestration request");
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      prewarmRuntimeEnvironmentAccess(sandbox, new AbortController().signal),
    ).resolves.toBeUndefined();
    // Access first, then exactly one shell request to build the runtime's state ahead of a run.
    expect(commands).toEqual([
      buildRuntimeEnvironmentReadinessCommand(),
      buildRuntimeEnvironmentSessionProbeCommand(),
      buildRuntimeEnvironmentAuthenticationCommand(),
      buildRuntimeEnvironmentProtocolProbeCommand(),
      expect.stringContaining("/api/orchestration/shell"),
    ]);
    // The warm-up gets the boot script's budget, not a running runtime's.
    expect(commands[4]).toContain("-m 60");
  });

  test("revalidates cached access and retries once when a request fails", async () => {
    const commands: string[] = [];
    let orchestrationRequests = 0;
    const sandbox = {
      id: "cube-t3-revalidate",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentReadinessCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentSessionProbeCommand()) {
            return { exitCode: 0, result: "" };
          }
          orchestrationRequests += 1;
          return orchestrationRequests === 2
            ? { exitCode: 1, result: "" }
            : { exitCode: 0, result: '{"projects":[],"threads":[]}' };
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      requestRuntimeEnvironment<{ projects: unknown[]; threads: unknown[] }>(
        sandbox,
        { method: "GET", path: "/api/orchestration/shell" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ projects: [], threads: [] });
    await expect(
      requestRuntimeEnvironment<{ projects: unknown[]; threads: unknown[] }>(
        sandbox,
        { method: "GET", path: "/api/orchestration/shell" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ projects: [], threads: [] });

    expect(commands).toEqual([
      buildRuntimeEnvironmentFirstAccessCommand(
        { method: "GET", path: "/api/orchestration/shell" },
        ROOT_LAYOUT,
      ),
      expect.stringContaining("/api/orchestration/shell"),
      buildRuntimeEnvironmentReadinessCommand(),
      buildRuntimeEnvironmentSessionProbeCommand(),
      buildRuntimeEnvironmentProtocolProbeCommand(),
      expect.stringContaining("/api/orchestration/shell"),
    ]);
  });

  test("surfaces a missing T3 thread without retrying it as stale authentication", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "cube-t3-missing-thread",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentReadinessCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentSessionProbeCommand()) {
            return { exitCode: 0, result: "" };
          }
          return {
            exitCode: 0,
            result: [
              JSON.stringify({
                code: "not_found",
                reason: "thread_not_found",
                traceId: "trace-missing-thread",
              }),
              "__USEAGENT_T3_HTTP_STATUS__:404",
            ].join("\n"),
          };
        },
      },
    } as unknown as SandboxHandle;

    const request = requestRuntimeEnvironment(
      sandbox,
      { method: "GET", path: "/api/orchestration/threads/thread-missing/bounded" },
      new AbortController().signal,
    );

    await expect(request).rejects.toBeInstanceOf(RuntimeEnvironmentRequestError);
    await expect(request).rejects.toMatchObject({
      status: 404,
      response: {
        code: "not_found",
        reason: "thread_not_found",
        traceId: "trace-missing-thread",
      },
    });
    expect(commands).toEqual([
      buildRuntimeEnvironmentFirstAccessCommand(
        { method: "GET", path: "/api/orchestration/threads/thread-missing/bounded" },
        ROOT_LAYOUT,
      ),
    ]);
  });

  test("revalidates websocket ticket access after a stale cached failure", async () => {
    const commands: string[] = [];
    let ticketRequests = 0;
    const sandbox = {
      id: "cube-t3-ticket-revalidate",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentReadinessCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentSessionProbeCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentProtocolProbeCommand()) {
            return { exitCode: 0, result: "" };
          }
          if (command === buildRuntimeEnvironmentWebSocketTicketCommand()) {
            ticketRequests += 1;
            return ticketRequests === 2
              ? { exitCode: 1, result: "" }
              : { exitCode: 0, result: '{"ticket":"0123456789abcdef"}' };
          }
          throw new Error("unexpected command");
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      issueRuntimeEnvironmentWebSocketTicket(sandbox, new AbortController().signal),
    ).resolves.toBe("0123456789abcdef");
    await expect(
      issueRuntimeEnvironmentWebSocketTicket(sandbox, new AbortController().signal),
    ).resolves.toBe("0123456789abcdef");

    expect(commands).toEqual([
      buildRuntimeEnvironmentReadinessCommand(),
      buildRuntimeEnvironmentSessionProbeCommand(),
      buildRuntimeEnvironmentProtocolProbeCommand(),
      buildRuntimeEnvironmentWebSocketTicketCommand(),
      buildRuntimeEnvironmentWebSocketTicketCommand(),
      buildRuntimeEnvironmentReadinessCommand(),
      buildRuntimeEnvironmentSessionProbeCommand(),
      buildRuntimeEnvironmentProtocolProbeCommand(),
      buildRuntimeEnvironmentWebSocketTicketCommand(),
    ]);
  });
});

describe("runtime request failures carry the runtime's own reason", () => {
  test("an orchestration refusal reads as its reason and detail", async () => {
    const { runtimeEnvironmentErrorDetail } = await import("./runtime-environment-client");
    expect(
      runtimeEnvironmentErrorDetail({
        reason: "orchestration_dispatch_failed",
        traceId: "27ad985f",
        cause: {
          _tag: "OrchestrationCommandInvariantError",
          commandType: "thread.session.stop",
          detail: "thread t1 was re-engaged after settle; skipping session stop",
        },
      }),
    ).toBe("orchestration_dispatch_failed: thread t1 was re-engaged after settle; skipping session stop");
  });

  test("a named error body reads as its message, and an empty body adds nothing", async () => {
    const { runtimeEnvironmentErrorDetail } = await import("./runtime-environment-client");
    expect(runtimeEnvironmentErrorDetail({ name: "ProviderModelNotFoundError", data: { message: "Model not found: x" } })).toBe(
      "Model not found: x",
    );
    expect(runtimeEnvironmentErrorDetail({ error: "boom" })).toBe("boom");
    expect(runtimeEnvironmentErrorDetail({})).toBeUndefined();
    expect(runtimeEnvironmentErrorDetail(undefined)).toBeUndefined();
    expect(runtimeEnvironmentErrorDetail({ message: "x".repeat(300) })?.length).toBe(240);
  });
});
