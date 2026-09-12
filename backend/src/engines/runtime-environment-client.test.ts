import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  buildRuntimeEnvironmentFirstAccessCommand,
  buildRuntimeEnvironmentAuthenticationCommand,
  buildRuntimeEnvironmentRequestCommand,
  buildRuntimeEnvironmentSessionProbeCommand,
  buildRuntimeEnvironmentWebSocketTicketCommand,
  decodeRuntimeEnvironmentCommandOutput,
  issueRuntimeEnvironmentWebSocketTicket,
  prewarmRuntimeEnvironmentAccess,
  requestRuntimeEnvironment,
  RuntimeEnvironmentRequestError,
} from "./runtime-environment-client";
import { buildRuntimeEnvironmentReadinessCommand } from "./runtime-environment";
import { buildNativeRuntimeArtifactProbe } from "./native-runtime-artifact";

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

describe("T3 environment client", () => {
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
      '"/root/.local/share/useagent/native-runtime/524d46b26f5ac85c82cd41e20f6c709d9f08db9b/bin/t3" auth pairing create',
    );
    expect(command).not.toMatch(/(^|\s)t3 auth pairing create/);
    expect(command).toContain('--json >"$PAIRING"');
    expect(command).toContain("/api/auth/browser-session");
    expect(command).toContain("chmod 600");
    expect(command).toContain('rm -f "$PAIRING"');
    expect(command).not.toContain("echo $PAIRING");
    expect(command).not.toContain("0.0.0.0");
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("uses the resident native runtime artifact for Box authentication", () => {
    const command = buildRuntimeEnvironmentAuthenticationCommand(BOX_LAYOUT);

    expect(command).toContain(
      '"/home/user/.local/share/useagent/native-runtime/524d46b26f5ac85c82cd41e20f6c709d9f08db9b/bin/t3" auth pairing create',
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
      path: "/api/orchestration/dispatch",
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
        path: "/api/orchestration/dispatch",
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
        path: "/api/orchestration/threads/thread-1;touch-/tmp/nope",
      }),
    ).toThrow("invalid runtime loopback path");
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
    expect(commands).toHaveLength(2);
    expect(commands).toEqual([
      buildRuntimeEnvironmentFirstAccessCommand(
        { method: "GET", path: "/api/orchestration/shell" },
        ROOT_LAYOUT,
      ),
      expect.stringContaining("/api/orchestration/shell"),
    ]);
    expect(Bun.spawnSync(["bash", "-n", "-c", commands[0]!]).exitCode).toBe(0);
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
    expect(commands.filter((command) => command === buildNativeRuntimeArtifactProbe(ROOT_LAYOUT)))
      .toHaveLength(1);
    expect(commands.filter((command) => command === buildRuntimeEnvironmentAuthenticationCommand()))
      .toHaveLength(1);
    expect(commands.filter((command) => command === buildRuntimeEnvironmentRequestCommand(request)))
      .toHaveLength(2);
  });

  test("bootstraps Box authentication with the same native runtime launcher", async () => {
    const commands: string[] = [];
    const request = { method: "GET", path: "/api/orchestration/snapshot" } as const;
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
    expect(commands).toHaveLength(6);
    expect(commands[0]).toBe(firstAccess);
    expect(commands[1]).toBe(buildNativeRuntimeArtifactProbe(BOX_LAYOUT));
  });

  test("prewarms private access without making an orchestration request", async () => {
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
          throw new Error("unexpected orchestration request");
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      prewarmRuntimeEnvironmentAccess(sandbox, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(commands).toEqual([
      buildNativeRuntimeArtifactProbe(ROOT_LAYOUT),
      buildRuntimeEnvironmentReadinessCommand(),
      buildRuntimeEnvironmentSessionProbeCommand(),
      buildRuntimeEnvironmentAuthenticationCommand(),
    ]);
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
      buildNativeRuntimeArtifactProbe(ROOT_LAYOUT),
      buildRuntimeEnvironmentReadinessCommand(),
      buildRuntimeEnvironmentSessionProbeCommand(),
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
      { method: "GET", path: "/api/orchestration/threads/thread-missing" },
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
        { method: "GET", path: "/api/orchestration/threads/thread-missing" },
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
      buildNativeRuntimeArtifactProbe(ROOT_LAYOUT),
      buildRuntimeEnvironmentReadinessCommand(),
      buildRuntimeEnvironmentSessionProbeCommand(),
      buildRuntimeEnvironmentWebSocketTicketCommand(),
      buildRuntimeEnvironmentWebSocketTicketCommand(),
      buildNativeRuntimeArtifactProbe(ROOT_LAYOUT),
      buildRuntimeEnvironmentReadinessCommand(),
      buildRuntimeEnvironmentSessionProbeCommand(),
      buildRuntimeEnvironmentWebSocketTicketCommand(),
    ]);
  });
});
