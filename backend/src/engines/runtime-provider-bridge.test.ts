import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  awaitRuntimeProviderReady,
  buildRuntimeProviderReadyProbeCommand,
  buildRuntimeProviderBootstrapCommand,
  claudeProviderReadiness,
  codexBridgeAuthPath,
  prepareRuntimeProviderBridge,
  prewarmRuntimeProviderBridge,
  resetRuntimeProviderBridgeCacheForTest,
} from "./runtime-provider-bridge";

const claudeEnvironment = {
  ANTHROPIC_BASE_URL: "https://gateway.example.test/provider/anthropic",
  CLAUDE_CONFIG_DIR: "/tmp/skynet-claude-config",
};

const previousGatewayUrl = process.env.PROVIDER_GATEWAY_PUBLIC_URL;
const previousGatewaySecret = process.env.PROVIDER_GATEWAY_SECRET;

beforeEach(() => {
  resetRuntimeProviderBridgeCacheForTest();
  process.env.PROVIDER_GATEWAY_PUBLIC_URL = "https://gateway.example.test";
  process.env.PROVIDER_GATEWAY_SECRET =
    "provider-test-0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  resetRuntimeProviderBridgeCacheForTest();
  if (previousGatewayUrl === undefined) delete process.env.PROVIDER_GATEWAY_PUBLIC_URL;
  else process.env.PROVIDER_GATEWAY_PUBLIC_URL = previousGatewayUrl;
  if (previousGatewaySecret === undefined) delete process.env.PROVIDER_GATEWAY_SECRET;
  else process.env.PROVIDER_GATEWAY_SECRET = previousGatewaySecret;
});

describe("T3 provider bridge", () => {
  test("routes Codex credentials without silently weakening subscription mode", () => {
    expect(codexBridgeAuthPath(true, { ENGINE_AUTH_MODE_CODEX: "subscription" }))
      .toBe("subscription");
    expect(() => codexBridgeAuthPath(false, { ENGINE_AUTH_MODE_CODEX: "subscription" }))
      .toThrow("codex_subscription_required");
    expect(codexBridgeAuthPath(true, { ENGINE_AUTH_MODE_CODEX: "provider_gateway" }))
      .toBe("provider_gateway");
    expect(codexBridgeAuthPath(true, { ENGINE_AUTH_MODE_CODEX: "hybrid" }))
      .toBe("subscription");
    expect(codexBridgeAuthPath(false, { ENGINE_AUTH_MODE_CODEX: "hybrid" }))
      .toBe("provider_gateway");
    expect(() => codexBridgeAuthPath(true, { ENGINE_AUTH_MODE_CODEX: "unknown" }))
      .toThrow("invalid ENGINE_AUTH_MODE_CODEX");
  });

  test("uses private dynamic provider files instead of persisted credentials", () => {
    const command = buildRuntimeProviderBootstrapCommand("claude", claudeEnvironment);
    const payloads = [...command.matchAll(/printf %s '([^']+)' \| base64 -d/g)];
    const wrapper = Buffer.from(payloads[0]![1]!, "base64").toString("utf8");
    const accessHelper = Buffer.from(payloads[1]![1]!, "base64").toString("utf8");

    expect(command).toContain("userdata/settings.json");
    expect(command).toContain("skynet-bin/claude");
    expect(command).toContain('useagent-claude-bun.XXXXXX');
    expect(command).toContain('BUN_INSTALL_GLOBAL_DIR="$NATIVE_GLOBAL_DIR"');
    expect(command).toContain('BUN_INSTALL_BIN="$NATIVE_PREFIX/bin"');
    expect(command).toContain('@anthropic-ai/claude-code@2.1.226');
    expect(wrapper).toContain('--settings "/tmp/useagent-claude-capability/useagent-settings.json"');
    expect(wrapper).toContain('--mcp-config "/tmp/useagent-claude-capability/useagent-mcp.json"');
    expect(wrapper).toContain('test "$(id -u user)" = "$CLAUDE_UID"');
    expect(command).toContain('"$CLAUDE_ACCESS_HELPER" "/root/work"');
    expect(accessHelper).toContain('setfacl -m "u:$CLAUDE_UID:x" /root');
    expect(accessHelper).toContain('chown root:root "$CLAUDE_WORKDIR"');
    expect(accessHelper).toContain('chmod 1777 "$CLAUDE_WORKDIR"');
    expect(accessHelper).not.toContain('chown -R "$CLAUDE_UID:$CLAUDE_GID" "$CLAUDE_WORKDIR"');
    expect(accessHelper).not.toContain("nonroot-access-v1");
    expect(wrapper).toContain(
      'setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --clear-groups --no-new-privs',
    );
    expect(wrapper).toContain('export HOME="$CLAUDE_HOME" USER=user LOGNAME=user');
    expect(wrapper).not.toContain("IS_SANDBOX");
    expect(command).toContain("chmod 700");
    expect(command).toContain("chmodSync(tmp,0o600)");
    expect(command).not.toContain("ANTHROPIC_API_KEY");
    expect(command).not.toContain("OPENAI_API_KEY");
    expect(command).not.toContain("Bearer ");
  });

  test("uses a same-user Claude wrapper and private package prefix on Box", () => {
    const command = buildRuntimeProviderBootstrapCommand("claude", claudeEnvironment, {
      home: "/home/user",
      workdir: "/home/user/work",
      runsAsRoot: false,
      bunExecutable: "/usr/local/bin/bun",
    });
    const payloads = [...command.matchAll(/printf %s '([^']+)' \| base64 -d/g)];
    const wrapper = Buffer.from(payloads[0]![1]!, "base64").toString("utf8");
    const accessHelper = Buffer.from(payloads[1]![1]!, "base64").toString("utf8");

    expect(command).toContain('export HOME="/home/user"');
    expect(command).toContain('NATIVE_PREFIX="/home/user/.local"');
    expect(command).toContain('"$CLAUDE_ACCESS_HELPER" "/home/user/work"');
    expect(command).not.toContain("/root");
    expect(command).not.toContain("setfacl");
    expect(wrapper).toContain('exec "/home/user/.local/bin/claude" "$@"');
    expect(wrapper).not.toContain("setpriv");
    expect(accessHelper).toContain('test "$(id -u)" != "0"');
    expect(accessHelper).toContain('test -w "$CLAUDE_WORKDIR"');
    expect(Bun.spawnSync(["bash", "-n", "-c", command]).exitCode).toBe(0);
  });

  test("rejects non-HTTP provider endpoints", () => {
    expect(() =>
      buildRuntimeProviderBootstrapCommand("claude", {
        ANTHROPIC_BASE_URL: "file:///tmp/provider",
        CLAUDE_CONFIG_DIR: "/tmp/skynet-claude-config",
      }),
    ).toThrow("must use HTTP(S)");
  });

  test("requires the managed Claude config directory", () => {
    expect(() =>
      buildRuntimeProviderBootstrapCommand("claude", {
        ANTHROPIC_BASE_URL: "https://gateway.example.test/provider/anthropic",
      }),
    ).toThrow("incomplete");
  });

  test("materializes an absolute executable path and preserves unrelated settings", async () => {
    const home = await mkdtemp(join(tmpdir(), "skynet-t3-provider-"));
    try {
      const bin = join(home, ".local/bin");
      const workdir = join(home, "work");
      const settingsPath = join(home, ".skynet/t3/userdata/settings.json");
      await mkdir(join(home, ".skynet/t3/userdata"), { recursive: true });
      await mkdir(bin, { recursive: true });
      await mkdir(workdir, { recursive: true });
      await Bun.write(join(bin, "claude"), "#!/bin/sh\necho '2.1.226 (Claude Code)'\n");
      await Bun.$`chmod 700 ${join(bin, "claude")}`;
      const existingCodex = { enabled: true, binaryPath: "/custom/codex" };
      const existingOpenCode = { enabled: true, binaryPath: "/custom/opencode" };
      const existingInstance = { driver: "codex", displayName: "Custom Codex" };
      await Bun.write(settingsPath, JSON.stringify({
        enableProviderUpdateChecks: false,
        providers: { codex: existingCodex, opencode: existingOpenCode },
        providerInstances: { codex: existingInstance },
      }));
      const environment = {
        ...claudeEnvironment,
        CLAUDE_CONFIG_DIR: join(home, "claude-config"),
      };
      const command = buildRuntimeProviderBootstrapCommand("claude", environment, {
        home,
        workdir,
        runsAsRoot: false,
      });
      const readiness = claudeProviderReadiness(environment);
      const result = Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { ...process.env, HOME: home },
      });

      expect(result.exitCode).toBe(0);
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        enableProviderUpdateChecks: boolean;
        providers: {
          codex: typeof existingCodex;
          opencode: typeof existingOpenCode;
          claudeAgent: { binaryPath: string };
        };
        providerInstances: {
          codex: typeof existingInstance;
          claudeAgent: {
            driver: string;
            displayName: string;
            enabled: boolean;
            config: {
              enabled: boolean;
              binaryPath: string;
              homePath: string;
              customModels: string[];
              launchArgs: string;
            };
          };
        };
      };
      expect(settings.enableProviderUpdateChecks).toBe(false);
      expect(settings.providers.codex).toEqual(existingCodex);
      expect(settings.providers.opencode).toEqual(existingOpenCode);
      expect(settings.providerInstances.codex).toEqual(existingInstance);
      expect(settings.providers.claudeAgent.binaryPath).toBe(
        join(home, ".skynet/t3/skynet-bin/claude"),
      );
      expect(settings.providerInstances.claudeAgent).toEqual({
        driver: "claudeAgent",
        displayName: readiness.displayName,
        enabled: true,
        config: {
          enabled: true,
          binaryPath: join(home, ".skynet/t3/skynet-bin/claude"),
          homePath: join(home, "claude-config"),
          customModels: [],
          launchArgs: "",
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("bootstraps only the selected native engine and preserves other providers", async () => {
    const engines = [
      {
        id: "codex" as const,
        package: "@openai/codex@0.147.0",
        binary: "codex",
        version: "codex-cli 0.147.0",
      },
      {
        id: "opencode" as const,
        package: "opencode-ai@1.18.7",
        binary: "opencode",
        version: "1.18.7",
      },
    ];
    for (const engine of engines) {
      const home = await mkdtemp(join(tmpdir(), `useagent-${engine.id}-bootstrap-`));
      try {
        const bin = join(home, ".local/bin");
        const settingsPath = join(home, ".skynet/t3/userdata/settings.json");
        await mkdir(bin, { recursive: true });
        await mkdir(join(home, ".skynet/t3/userdata"), { recursive: true });
        await Bun.write(join(bin, engine.binary), `#!/bin/sh\necho '${engine.version}'\n`);
        await Bun.$`chmod 700 ${join(bin, engine.binary)}`;
        const untouched = { enabled: true, binaryPath: "/keep/me" };
        await Bun.write(settingsPath, JSON.stringify({
          providers: { claudeAgent: untouched },
          providerInstances: { claudeAgent: { driver: "claudeAgent" } },
        }));

        const command = buildRuntimeProviderBootstrapCommand(engine.id, {}, {
          home,
          workdir: join(home, "work"),
          runsAsRoot: false,
        });
        const result = Bun.spawnSync(["/bin/sh", "-c", command], {
          env: { ...process.env, HOME: home },
        });

        expect(result.exitCode).toBe(0);
        expect(command).toContain(engine.package);
        for (const otherPackage of [
          "@openai/codex@0.147.0",
          "@anthropic-ai/claude-code@2.1.226",
          "opencode-ai@1.18.7",
        ]) {
          if (otherPackage !== engine.package) expect(command).not.toContain(otherPackage);
        }
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
          providers: Record<string, { binaryPath: string }>;
          providerInstances: Record<string, unknown>;
        };
        expect(settings.providers[engine.id]?.binaryPath).toBe(join(bin, engine.binary));
        expect(settings.providers.claudeAgent).toEqual(untouched);
        expect(settings.providerInstances.claudeAgent).toEqual({ driver: "claudeAgent" });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });

  test("fails closed when a selected engine install fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-native-install-failure-"));
    try {
      const bin = join(home, ".local/bin");
      const fakeTools = join(home, "fake-tools");
      const settingsPath = join(home, ".skynet/t3/userdata/settings.json");
      await mkdir(bin, { recursive: true });
      await mkdir(fakeTools, { recursive: true });
      await mkdir(join(home, ".skynet/t3/userdata"), { recursive: true });
      await Bun.write(join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.1.0'\n");
      await Bun.write(join(fakeTools, "bun"), "#!/bin/sh\nexit 42\n");
      await Bun.$`chmod 700 ${join(bin, "codex")} ${join(fakeTools, "bun")}`;
      await Bun.write(settingsPath, JSON.stringify({ providers: { keep: { enabled: true } } }));
      const command = buildRuntimeProviderBootstrapCommand("codex", {}, {
        home,
        workdir: join(home, "work"),
        runsAsRoot: false,
      });

      const result = Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { ...process.env, HOME: home, PATH: `${fakeTools}:${process.env.PATH}` },
      });

      expect(result.exitCode).toBe(42);
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
        providers: { keep: { enabled: true } },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("accepts only T3's current reconciled Claude gateway instance marker", async () => {
    const home = await mkdtemp(join(tmpdir(), "skynet-t3-claude-ready-"));
    try {
      const cachePath = join(home, ".skynet/t3/caches/claudeAgent.json");
      await mkdir(join(home, ".skynet/t3/caches"), { recursive: true });
      const readiness = claudeProviderReadiness(claudeEnvironment);
      const command = buildRuntimeProviderReadyProbeCommand(readiness);
      const runProbe = () => Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { ...process.env, HOME: home },
      }).exitCode;

      await Bun.write(cachePath, JSON.stringify({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: claudeProviderReadiness({
          ...claudeEnvironment,
          ANTHROPIC_BASE_URL: "https://stale.example.test/provider/anthropic",
        }).displayName,
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
      }));
      expect(runProbe()).not.toBe(0);

      await Bun.write(cachePath, JSON.stringify({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: readiness.displayName,
        enabled: true,
        installed: false,
        status: "warning",
        auth: { status: "unknown" },
      }));
      expect(runProbe()).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("waits until T3 publishes the Claude gateway instance", async () => {
    let attempts = 0;
    const sandbox = {
      process: {
        executeCommand: async () => ({
          exitCode: ++attempts === 2 ? 0 : 1,
          result: "",
        }),
      },
    } as unknown as Pick<SandboxHandle, "process">;

    await expect(
      awaitRuntimeProviderReady(
        sandbox,
        new AbortController().signal,
        1_000,
        claudeProviderReadiness(claudeEnvironment),
      ),
    ).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  test("keeps the readiness deadline hard even when a probe hangs", async () => {
    const sandbox = {
      process: {
        executeCommand: async () => await new Promise<never>(() => {}),
      },
    } as unknown as Pick<SandboxHandle, "process">;
    const startedAt = performance.now();

    await expect(
      awaitRuntimeProviderReady(
        sandbox,
        new AbortController().signal,
        40,
        claudeProviderReadiness(claudeEnvironment),
      ),
    ).resolves.toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  test("preserves caller cancellation instead of returning a retryable timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("turn cancelled");
    const sandbox = {
      process: {
        executeCommand: async () => await new Promise<never>(() => {}),
      },
    } as unknown as Pick<SandboxHandle, "process">;
    setTimeout(() => controller.abort(reason), 10);

    await expect(
      awaitRuntimeProviderReady(
        sandbox,
        controller.signal,
        1_000,
        claudeProviderReadiness(claudeEnvironment),
      ),
    ).rejects.toBe(reason);
  });

  test("runs stable provider bootstrap once per live sandbox", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "t3-provider-warm-sandbox",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    await prewarmRuntimeProviderBridge(sandbox, { T3_ENVIRONMENT_ENABLED: "true" });
    await prewarmRuntimeProviderBridge(sandbox, { T3_ENVIRONMENT_ENABLED: "true" });

    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("@openai/codex@0.147.0");
    expect(commands[1]).toContain("@anthropic-ai/claude-code@2.1.226");
    expect(commands[2]).toContain("opencode-ai@1.18.7");
  });

  test("reasserts the Claude access boundary after resources on every retained turn", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "t3-provider-retained-claude",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;
    const context = {
      runId: "run-claude-a",
      threadId: "thread-claude",
      prompt: "work",
      bootstrapContext: "",
      turnContext: "",
      workdir: "/root/work",
      orgId: "org-a",
      userId: "user-a",
      model: "claude-sonnet-5",
      signal: new AbortController().signal,
      emit: async () => undefined,
      setSummary: () => undefined,
    } as const;

    await prepareRuntimeProviderBridge(sandbox, context, "claude", "/root/work");
    await prepareRuntimeProviderBridge(
      sandbox,
      { ...context, runId: "run-claude-b" },
      "claude",
      "/root/work",
    );

    expect(
      commands.filter((command) =>
        command.startsWith("$HOME/.skynet/t3/skynet-bin/prepare-claude-access ")
      ),
    ).toHaveLength(2);
    expect(commands.some((command) =>
      command.includes("install -d -o 0 -g 1000 -m 750 /tmp/useagent-claude-capability")
    )).toBe(true);
  });

  test("prepares Box Claude capability and wrapper without root ownership operations", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "box-provider-claude",
      providerKind: "box",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;
    const context = {
      runId: "run-box-claude",
      threadId: "thread-box-claude",
      prompt: "work",
      bootstrapContext: "",
      turnContext: "",
      workdir: "/home/user/work",
      orgId: "org-a",
      userId: "user-a",
      model: "claude-sonnet-5",
      signal: new AbortController().signal,
      emit: async () => undefined,
      setSummary: () => undefined,
    } as const;

    await prepareRuntimeProviderBridge(
      sandbox,
      context,
      "claude",
      "/home/user/work",
    );

    expect(commands.some((command) => command.includes("chown 0:1000"))).toBe(false);
    expect(commands.some((command) => command.includes('export HOME="/home/user"'))).toBe(true);
    expect(commands.some((command) =>
      command.startsWith("$HOME/.skynet/t3/skynet-bin/prepare-claude-access ") &&
      command.includes('"/home/user/work"')
    )).toBe(true);
  });

  test("evicts a failed bootstrap so a later attempt can recover", async () => {
    let attempts = 0;
    const sandbox = {
      id: "t3-provider-retry-sandbox",
      process: {
        executeCommand: async () => {
          attempts += 1;
          return { exitCode: attempts === 1 ? 1 : 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      prewarmRuntimeProviderBridge(sandbox, { T3_ENVIRONMENT_ENABLED: "true" }),
    ).rejects.toThrow("bootstrap failed");
    await expect(
      prewarmRuntimeProviderBridge(sandbox, { T3_ENVIRONMENT_ENABLED: "true" }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(4);
  });

  test("does not materialize ChatGPT OAuth through sandbox bootstrap", () => {
    const command = buildRuntimeProviderBootstrapCommand("claude", {
      ANTHROPIC_BASE_URL: "https://gateway.example.test/provider/anthropic",
      CLAUDE_CONFIG_DIR: "/tmp/skynet-claude-config",
    });

    expect(command).not.toContain("chatgpt");
    expect(command).not.toContain("codex-subscription-broker");
    expect(command).not.toContain("auth.json");
  });
});
