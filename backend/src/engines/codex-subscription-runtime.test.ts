import { describe, expect, test } from "bun:test";
import type { SandboxHandle, SandboxExecuteResult } from "../sandboxes/provider";
import type { CodexSubscriptionRelayBinding } from "../provider-connections/codex-subscription-relay";
import type { CodexSubscriptionRuntimeSelection } from "../provider-connections/service";
import type { EngineRunContext } from "./types";
import {
  awaitT3CodexProviderReady,
  buildCodexExecServerCommand,
  buildCodexExecServerReadinessCommand,
  buildT3CodexProviderInstanceCommand,
  buildT3CodexProviderReadyProbeCommand,
  prepareT3CodexSubscription,
  previewWebSocketUrl,
} from "./codex-subscription-runtime";

describe("T3 Codex subscription lease", () => {
  test("binds the host relay to the exact run and remote execution environment", async () => {
    const harness = fakeSandbox();
    const closed: string[] = [];
    let relayBinding: CodexSubscriptionRelayBinding | undefined;
    let relayRuntime: CodexSubscriptionRuntimeSelection | undefined;
    let relayExecServerUrl: string | undefined;

    const lease = await prepareT3CodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        openExecBridge: (input) => {
          expect(input).toEqual({
            upstreamUrl: "wss://preview.example.test/",
            expectedUpstreamHost: "preview.example.test",
            headers: { "x-daytona-preview-token": "preview-secret" },
          });
          return { url: "ws://127.0.0.1:43111/grant", close: () => closed.push("bridge") };
        },
        issueRelay: (input) => {
          relayBinding = input.binding;
          relayRuntime = input.runtime;
          relayExecServerUrl = input.execServerUrl;
          return {
            url: "wss://skynet.example.test/api/internal/codex-relay/opaque",
            close: () => closed.push("relay"),
          };
        },
      },
    });

    expect(harness.createdSessions).toEqual(["skynet-codex-exec-server"]);
    expect(harness.sessionCommands).toHaveLength(1);
    expect(harness.sessionCommands[0]?.command).toContain(
      "codex exec-server --listen ws://0.0.0.0:37734",
    );
    expect(harness.previewPorts).toEqual([37_734]);
    expect(relayBinding).toEqual({
      orgId: "org-1",
      userId: "user-1",
      threadId: "thread-1",
      runId: "run-1",
      connectionId: "connection-1",
      authEpoch: "credential-generation-123",
      model: "gpt-5.5",
      sandboxId: "sandbox-1",
      sandboxGeneration: "t3-v3",
      environmentId: "skynet-sandbox-1-run-1",
      cwd: "/root/work",
    });
    expect(relayRuntime).toEqual(runtime());
    expect(relayExecServerUrl).toBe("ws://127.0.0.1:43111/grant");

    const providerPatch = harness.commands.at(-1)?.command ?? "";
    expect(providerPatch).toContain("CODEX_INSTANCE_B64");
    expect(providerPatch).not.toContain("/host/codex-home");
    expect(providerPatch).not.toContain("preview-secret");
    expect(providerPatch).not.toContain("SKYNET_TOOL_GATEWAY_BEARER_TOKEN");

    await lease.close();
    await lease.close();

    expect(closed).toEqual(["relay", "bridge"]);
    expect(harness.deletedSessions).toEqual([
      "skynet-codex-exec-server",
      "skynet-codex-exec-server",
    ]);
    expect(harness.commands.at(-1)?.command).toContain(
      "delete current.providerInstances.codex",
    );
  });

  test("unwinds the exec server and bridges when provider configuration fails", async () => {
    const harness = fakeSandbox({ failProviderPatch: true });
    const closed: string[] = [];

    await expect(prepareT3CodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        openExecBridge: () => ({
          url: "ws://127.0.0.1:43111/grant",
          close: () => closed.push("bridge"),
        }),
        issueRelay: () => ({
          url: "wss://skynet.example.test/api/internal/codex-relay/opaque",
          close: () => closed.push("relay"),
        }),
      },
    })).rejects.toThrow("provider configuration failed");

    expect(closed).toEqual(["relay", "bridge"]);
    expect(harness.deletedSessions).toEqual([
      "skynet-codex-exec-server",
      "skynet-codex-exec-server",
    ]);
  });

  test("fails closed before minting a capability without tenant identity", async () => {
    const harness = fakeSandbox();
    let issued = false;

    await expect(prepareT3CodexSubscription({
      sandbox: harness.sandbox,
      ctx: { ...context(), orgId: null },
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        openExecBridge: () => ({
          url: "ws://127.0.0.1:43111/grant",
          close() {},
        }),
        issueRelay: () => {
          issued = true;
          throw new Error("unreachable");
        },
      },
    })).rejects.toThrow("organization identity is required");

    expect(issued).toBe(false);
    expect(harness.createdSessions).toEqual([]);
    expect(harness.deletedSessions).toEqual([]);
  });

  test("builds shell-safe commands with no host credential material", () => {
    expect(buildCodexExecServerCommand("skynet-run-1")).toContain(
      "--environment-id skynet-run-1",
    );
    expect(() => buildCodexExecServerCommand("unsafe; touch /tmp/pwned")).toThrow(
      "environment id is unsafe",
    );
    expect(buildCodexExecServerReadinessCommand()).toContain("127.0.0.1");

    const patch = buildT3CodexProviderInstanceCommand({
      relayUrl: "wss://skynet.example.test/api/internal/codex-relay/opaque",
      environmentId: "skynet-run-1",
      workdir: "/root/work",
    });
    expect(patch).not.toContain("CODEX_HOME");
    expect(patch).not.toContain("access_token");
    expect(patch).not.toContain("refresh_token");
  });

  test("accepts only the configured Cube preview domain", () => {
    const env = { CUBE_SANDBOX_DOMAIN: "sandbox.example.com", NODE_ENV: "test" };
    expect(previewWebSocketUrl(
      "https://37734-sandbox-1.sandbox.example.com/exec",
      "cube",
      env,
    )).toBe("wss://37734-sandbox-1.sandbox.example.com/exec");
    expect(() => previewWebSocketUrl(
      "https://37734-sandbox-1.attacker.example/exec",
      "cube",
      env,
    )).toThrow("outside the Cube sandbox domain");
  });

  test("readiness probe keys on the subscription instance display name in the cache", () => {
    const command = buildT3CodexProviderReadyProbeCommand();
    // Reads the status cache CONTENT (not mtime) for the subscription-only marker.
    expect(command).toContain("caches/codex.json");
    expect(command).toContain("displayName");
    expect(command).toContain("Codex subscription");
    // The probe marker matches the display name the provider-instance patch sets.
    const patch = buildT3CodexProviderInstanceCommand({
      relayUrl: "wss://skynet.example.test/api/internal/codex-relay/opaque",
      environmentId: "skynet-run-1",
      workdir: "/root/work",
    });
    const encoded = patch.match(/CODEX_INSTANCE_B64='([^']+)'/)?.[1] ?? "";
    const instance = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      displayName?: string;
    };
    expect(instance.displayName).toBe("Codex subscription");
  });

  test("readiness barrier confirms once the status cache reports the remote instance", async () => {
    let ready = false;
    const commands: string[] = [];
    const sandbox = {
      process: {
        async executeCommand(command: string) {
          commands.push(command);
          return { exitCode: ready ? 0 : 1 } satisfies Partial<SandboxExecuteResult>;
        },
      },
    } as unknown as SandboxHandle;

    // A zero-length deadline that never confirms falls back (returns false).
    await expect(
      awaitT3CodexProviderReady(sandbox, new AbortController().signal, 0),
    ).resolves.toBe(false);
    // Once the cache reports the subscription instance, the barrier confirms.
    ready = true;
    await expect(
      awaitT3CodexProviderReady(sandbox, new AbortController().signal, 0),
    ).resolves.toBe(true);
    expect(commands.every((command) => command.includes("caches/codex.json"))).toBe(true);
  });

  test("readiness barrier stops immediately when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const sandbox = {
      process: {
        async executeCommand() {
          calls += 1;
          return { exitCode: 1 } satisfies Partial<SandboxExecuteResult>;
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      awaitT3CodexProviderReady(sandbox, controller.signal, 5_000),
    ).resolves.toBe(false);
    expect(calls).toBe(0);
  });
});

function context(): EngineRunContext {
  return {
    runId: "run-1",
    threadId: "thread-1",
    orgId: "org-1",
    userId: "user-1",
    model: "gpt-5.5",
    prompt: "hello",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/root/work",
    signal: new AbortController().signal,
    async emit() {
      return undefined;
    },
    setSummary() {},
  };
}

function runtime(): CodexSubscriptionRuntimeSelection {
  return {
    authMethod: "chatgpt_oauth",
    mode: "managed_codex_app_server",
    connectionId: "connection-1",
    authEpoch: "credential-generation-123",
    codexHome: "/host/codex-home",
    metadata: { email: "me@example.test", planType: "pro" },
  };
}

function fakeSandbox(options: { failProviderPatch?: boolean } = {}) {
  const commands: Array<{ command: string; result: SandboxExecuteResult }> = [];
  const createdSessions: string[] = [];
  const deletedSessions: string[] = [];
  const sessionCommands: Array<{ sessionId: string; command: string }> = [];
  const previewPorts: number[] = [];
  const sandbox = {
    id: "sandbox-1",
    cpu: 2,
    memory: 4,
    process: {
      async executeCommand(command: string) {
        const providerPatch = command.includes("CODEX_INSTANCE_B64");
        const result = { exitCode: providerPatch && options.failProviderPatch ? 1 : 0 };
        commands.push({ command, result });
        return result;
      },
      async createSession(sessionId: string) {
        createdSessions.push(sessionId);
      },
      async deleteSession(sessionId: string) {
        deletedSessions.push(sessionId);
      },
      async executeSessionCommand(sessionId: string, request: { command: string }) {
        sessionCommands.push({ sessionId, command: request.command });
        return { cmdId: "cmd-1", exitCode: 0 };
      },
    },
    async getPreviewLink(port: number) {
      previewPorts.push(port);
      return { url: "https://preview.example.test", token: "preview-secret" };
    },
  } as unknown as SandboxHandle;
  return {
    sandbox,
    commands,
    createdSessions,
    deletedSessions,
    sessionCommands,
    previewPorts,
  };
}
