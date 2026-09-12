import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "../sandboxes/provider";
import { buildSandboxBunProbeCommand } from "./sandbox-bun";
import {
  awaitRuntimeProviderReady,
  buildCodexInstallIdentityProbeCommand,
  buildClaudeInstallIdentityProbeCommand,
  buildOpenCodeInstallIdentityProbeCommand,
  buildRuntimeProviderReadyProbeCommand,
  buildRuntimeProviderBootstrapCommand,
  claudeProviderReadiness,
  codexBridgeAuthPath,
  openCodeModelLimitsChanged,
  prepareRuntimeProviderBridge,
  prepareStableRuntimeProvider,
  prewarmRuntimeProviderBridge,
  resetRuntimeProviderBridgeCacheForTest,
} from "./runtime-provider-bridge";

const claudeEnvironment = {
  ANTHROPIC_BASE_URL: "https://gateway.example.test/provider/anthropic",
  CLAUDE_CONFIG_DIR: "/tmp/skynet-claude-config",
};

const previousGatewayUrl = process.env.PROVIDER_GATEWAY_PUBLIC_URL;
const previousGatewaySecret = process.env.PROVIDER_GATEWAY_SECRET;

// This is a header fixture for install validation, not a runnable native server.
// Actual startup/session readiness belongs to the native adapter boundary.
const nativeElfHeaderFixture = Buffer.from("\x7fELF\ninstall identity fixture\n");
const openCodePostinstallPlaceholder = `echo "Error: opencode-ai's postinstall script was not run." >&2
echo "" >&2
echo "This occurs when using --ignore-scripts during installation, or when using a" >&2
echo "package manager like pnpm that does not run postinstall scripts by default." >&2
echo "" >&2
echo "To fix this, run the postinstall script manually:" >&2
echo "  cd node_modules/opencode-ai && node postinstall.mjs" >&2
echo "" >&2
echo "Or reinstall opencode-ai without the --ignore-scripts flag." >&2
exit 1
`;

async function runColdClaudeBootstrap(
  binaryScript: (home: string) => string,
  packageVersion = "2.1.226",
): Promise<{
  home: string;
  result: ReturnType<typeof Bun.spawnSync>;
  versionCountPath: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "useagent-cold-claude-bootstrap-"));
  const fakeTools = join(home, "fake-tools");
  const versionCountPath = join(home, "version-count");
  await mkdir(fakeTools, { recursive: true });
  await mkdir(join(home, "work"), { recursive: true });
  const encodedBinary = Buffer.from(binaryScript(home), "utf8").toString("base64");
  const encodedManifest = Buffer.from(JSON.stringify({
    name: "@anthropic-ai/claude-code",
    version: packageVersion,
    bin: { claude: "bin/claude.exe" },
  }), "utf8").toString("base64");
  await Bun.write(join(fakeTools, "bun"), [
    "#!/bin/sh",
    "set -eu",
    'PACKAGE_DIR="$BUN_INSTALL_GLOBAL_DIR/node_modules/@anthropic-ai/claude-code"',
    'mkdir -p "$BUN_INSTALL_BIN" "$PACKAGE_DIR"',
    'mkdir -p "$PACKAGE_DIR/bin"',
    `printf %s '${encodedBinary}' | base64 -d > "$PACKAGE_DIR/bin/claude.exe"`,
    `printf %s '${encodedManifest}' | base64 -d > "$PACKAGE_DIR/package.json"`,
    'chmod 700 "$PACKAGE_DIR/bin/claude.exe"',
    'ln -sf "$PACKAGE_DIR/bin/claude.exe" "$BUN_INSTALL_BIN/claude"',
    "",
  ].join("\n"));
  await Bun.$`chmod 700 ${join(fakeTools, "bun")}`;
  const command = buildRuntimeProviderBootstrapCommand("claude", {
    ANTHROPIC_BASE_URL: "https://gateway.example.test/provider/anthropic",
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
  }, {
    home,
    workdir: join(home, "work"),
    runsAsRoot: false,
    bunExecutable: join(fakeTools, "bun"),
  });
  return {
    home,
    result: Bun.spawnSync(["/bin/sh", "-c", command], {
      env: { ...process.env, HOME: home, PATH: `${fakeTools}:${process.env.PATH}` },
    }),
    versionCountPath,
  };
}

async function runColdOpenCodeBootstrap(
  packageVersion = "1.18.7",
  installedBinary: Uint8Array = nativeElfHeaderFixture,
): Promise<{
  home: string;
  result: ReturnType<typeof Bun.spawnSync>;
  launchMarker: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "useagent-cold-opencode-bootstrap-"));
  const fakeTools = join(home, "fake-tools");
  const launchMarker = join(home, "opencode-launched");
  await mkdir(fakeTools, { recursive: true });
  const encodedBinary = Buffer.from(installedBinary).toString("base64");
  const encodedManifest = Buffer.from(JSON.stringify({
    name: "opencode-ai",
    version: packageVersion,
    bin: { opencode: "./bin/opencode.exe" },
  }), "utf8").toString("base64");
  await Bun.write(join(fakeTools, "bun"), [
    "#!/bin/sh",
    "set -eu",
    'PACKAGE_DIR="$BUN_INSTALL_GLOBAL_DIR/node_modules/opencode-ai"',
    'mkdir -p "$BUN_INSTALL_BIN" "$PACKAGE_DIR/bin"',
    `printf %s '${encodedBinary}' | base64 -d > "$PACKAGE_DIR/bin/opencode.exe"`,
    `printf %s '${encodedManifest}' | base64 -d > "$PACKAGE_DIR/package.json"`,
    'chmod 700 "$PACKAGE_DIR/bin/opencode.exe"',
    'ln -sf "$PACKAGE_DIR/bin/opencode.exe" "$BUN_INSTALL_BIN/opencode"',
    "",
  ].join("\n"));
  await Bun.$`chmod 700 ${join(fakeTools, "bun")}`;
  const command = buildRuntimeProviderBootstrapCommand("opencode", {}, {
    home,
    workdir: join(home, "work"),
    runsAsRoot: false,
    bunExecutable: join(fakeTools, "bun"),
  });
  return {
    home,
    result: Bun.spawnSync(["/bin/sh", "-c", command], {
      env: { ...process.env, HOME: home, PATH: `${fakeTools}:${process.env.PATH}` },
    }),
    launchMarker,
  };
}

async function installFakeClaudePackage(
  home: string,
  script: string,
  version = "2.1.226",
): Promise<void> {
  const packageDirectory = join(
    home,
    ".local/share/useagent/native-engines/node_modules/@anthropic-ai/claude-code",
  );
  const binary = join(packageDirectory, "bin/claude.exe");
  const launcher = join(home, ".local/bin/claude");
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await Bun.write(binary, script);
  await Bun.write(join(packageDirectory, "package.json"), JSON.stringify({
    name: "@anthropic-ai/claude-code",
    version,
    bin: { claude: "bin/claude.exe" },
  }));
  await Bun.$`chmod 700 ${binary}`;
  await symlink(binary, launcher);
}

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
  test("detects only selected-model static limit changes", () => {
    const config = (output: number, token: string) => ({
      provider: {
        cerebras: {
          models: {
            "qwen-3.8-27b": {
              limit: { context: 65_536, input: 49_152, output },
            },
            "gemma-4-31b": {
              limit: { context: 131_072, output: 40_960 },
            },
          },
          options: { apiKey: token },
        },
      },
      mcp: { knowledge: { headers: { Authorization: token } } },
    });

    expect(openCodeModelLimitsChanged(
      config(32_768, "old-token"),
      config(16_384, "new-token"),
      "cerebras/qwen-3.8-27b",
    )).toBe(true);
    expect(openCodeModelLimitsChanged(
      config(16_384, "old-token"),
      config(16_384, "new-token"),
      "cerebras/qwen-3.8-27b",
    )).toBe(false);
    expect(openCodeModelLimitsChanged(
      config(32_768, "old-token"),
      config(16_384, "new-token"),
      "cerebras/gemma-4-31b",
    )).toBe(false);
    expect(openCodeModelLimitsChanged(
      {},
      config(16_384, "new-token"),
      "cerebras/qwen-3.8-27b",
    )).toBe(true);
  });

  test("retains the limit reload revision across a post-config crash until acknowledged", async () => {
    let config = JSON.stringify({
      provider: {
        cerebras: {
          models: {
            "qwen-3.8-27b": { limit: { context: 65_536, output: 32_768 } },
            "gemma-4-31b": { limit: { context: 131_072, output: 40_960 } },
          },
        },
      },
    });
    let desired = "";
    let acknowledged = "";
    let failMarker = false;
    const sandbox = {
      id: "opencode-limit-change",
      process: {
        executeCommand: async (command: string) => {
          if (command.startsWith("cat ~/.config/opencode/opencode.json")) {
            return { exitCode: 0, result: config };
          }
          if (command.includes("opencode-model-limits") && command.includes("printf '\\n'")) {
            return { exitCode: 0, result: `${desired}\n${acknowledged}` };
          }
          if (command.includes("opencode-model-limits") && command.includes("mv -f --")) {
            const encoded = command.match(/printf %s (".*") > "\$TMP"/)?.[1];
            expect(encoded).toBeDefined();
            const value = JSON.parse(encoded!) as string;
            if (command.includes("/model-")) desired = value;
            else acknowledged = value;
            return { exitCode: 0, result: "" };
          }
          if (command.includes("base64 -d > ~/.config/opencode/opencode.json")) {
            const encoded = command.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
            expect(encoded).toBeDefined();
            config = Buffer.from(encoded!, "base64").toString("utf8");
            return { exitCode: 0, result: "" };
          }
          if (command.includes("provider-gateway-generation") && failMarker) {
            failMarker = false;
            return { exitCode: 1, result: "" };
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;
    const context = {
      runId: "run-opencode-limit-change",
      threadId: "thread-opencode-limit-change",
      prompt: "work",
      bootstrapContext: "",
      turnContext: "",
      workdir: "/root/work",
      orgId: "org-a",
      userId: "user-a",
      model: "cerebras/qwen-3.8-27b",
      signal: new AbortController().signal,
      emit: async () => undefined,
      setSummary: () => undefined,
    } as const;

    const openAiLease = await prepareRuntimeProviderBridge(
      sandbox,
      { ...context, runId: "run-openai-first", model: "openai/gpt-5.6-luna" },
      "opencode",
      "/root/work",
    );
    expect(openAiLease.modelLimitsChanged).toBe(false);
    const pendingAfterOpenAiTurn = JSON.parse(desired) as {
      fingerprint: string;
      revision: string;
      createdAt: string;
    };
    const qwenAfterOpenAi = await prepareRuntimeProviderBridge(
      sandbox, context, "opencode", "/root/work"
    );
    expect(qwenAfterOpenAi.modelLimitsChanged).toBe(true);
    expect(qwenAfterOpenAi.modelLimitsRevision).toBe(pendingAfterOpenAiTurn.revision);

    const staleAgain = JSON.parse(config) as {
      provider: { cerebras: { models: { "qwen-3.8-27b": { limit: { output: number } } } } };
    };
    staleAgain.provider.cerebras.models["qwen-3.8-27b"].limit.output = 32_768;
    config = JSON.stringify(staleAgain);
    failMarker = true;
    await expect(prepareRuntimeProviderBridge(
      sandbox, context, "opencode", "/root/work"
    )).rejects.toThrow("failed to configure provider gateway");
    const pendingAfterCrash = JSON.parse(desired) as {
      fingerprint: string;
      revision: string;
      createdAt: string;
    };
    expect(pendingAfterCrash.revision).toBe(pendingAfterOpenAiTurn.revision);

    const lease = await prepareRuntimeProviderBridge(
      sandbox, context, "opencode", "/root/work"
    );

    expect(lease.modelLimitsChanged).toBe(true);
    expect(lease.modelLimitsRevision).toBe(pendingAfterCrash.revision);
    expect(lease.modelLimitsChangedAt).toBe(pendingAfterCrash.createdAt);
    expect(lease.readiness).toBeNull();
    expect(acknowledged).toBe("");

    await lease.ackModelLimitsReload();
    expect(acknowledged).toBe(pendingAfterCrash.revision);
    const settled = await prepareRuntimeProviderBridge(
      sandbox, context, "opencode", "/root/work"
    );
    expect(settled.modelLimitsChanged).toBe(false);

    const rolledBack = JSON.parse(config) as {
      provider: { cerebras: { models: { "qwen-3.8-27b": { limit: { output: number } } } } };
    };
    rolledBack.provider.cerebras.models["qwen-3.8-27b"].limit.output = 32_768;
    config = JSON.stringify(rolledBack);
    const repeatedLimit = await prepareRuntimeProviderBridge(
      sandbox, context, "opencode", "/root/work"
    );
    expect(repeatedLimit.modelLimitsChanged).toBe(true);
    expect(repeatedLimit.modelLimitsRevision).not.toBe(pendingAfterCrash.revision);
  });

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
    expect(command).toContain('node_modules/@anthropic-ai/claude-code');
    expect(command).toContain('manifest.version!==expectedVersion');
    expect(command).toContain('allowedRoots.some');
    expect(command).not.toContain('spawnSync');
    expect(command).not.toContain('--version');
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
    expect(command.indexOf('String(Date.now())')).toBeLessThan(
      command.indexOf('current.providerInstances='),
    );
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
      await mkdir(workdir, { recursive: true });
      await installFakeClaudePackage(home, "#!/bin/sh\nexit 17\n");
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
        package: "@openai/codex@0.153.3",
        binary: "codex",
        version: "codex-cli 0.153.3",
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
        if (engine.id === "opencode") {
          const packageDir = join(
            home,
            ".local/share/useagent/native-engines/node_modules/opencode-ai",
          );
          const packageBin = join(packageDir, "bin/opencode.exe");
          await mkdir(join(packageDir, "bin"), { recursive: true });
          await Bun.write(packageBin, nativeElfHeaderFixture);
          await Bun.write(join(packageDir, "package.json"), JSON.stringify({
            name: "opencode-ai",
            version: "1.18.7",
            bin: { opencode: "./bin/opencode.exe" },
          }));
          await Bun.$`chmod 700 ${packageBin}`;
          await symlink(packageBin, join(bin, engine.binary));
        } else {
          const packageDir = join(
            home,
            ".local/share/useagent/native-engines/node_modules/@openai/codex",
          );
          const packageBin = join(packageDir, "bin/codex.js");
          const platform = process.arch === "arm64"
            ? { alias: "codex-linux-arm64", suffix: "linux-arm64", triple: "aarch64-unknown-linux-musl" }
            : { alias: "codex-linux-x64", suffix: "linux-x64", triple: "x86_64-unknown-linux-musl" };
          const platformDir = join(
            home,
            `.local/share/useagent/native-engines/node_modules/@openai/${platform.alias}`,
          );
          const nativeBin = join(platformDir, `vendor/${platform.triple}/bin/codex`);
          await mkdir(join(packageDir, "bin"), { recursive: true });
          await mkdir(join(platformDir, `vendor/${platform.triple}/bin`), { recursive: true });
          await Bun.write(packageBin, `#!/bin/sh\necho '${engine.version}'\n`);
          await Bun.write(join(packageDir, "package.json"), JSON.stringify({
            name: "@openai/codex",
            version: "0.153.3",
            bin: { codex: "bin/codex.js" },
          }));
          await Bun.write(nativeBin, "native fixture");
          await Bun.write(join(platformDir, "package.json"), JSON.stringify({
            name: "@openai/codex",
            version: `0.153.3-${platform.suffix}`,
          }));
          await Bun.$`chmod 700 ${packageBin} ${nativeBin}`;
          await symlink(packageBin, join(bin, engine.binary));
        }
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
          "@openai/codex@0.153.3",
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
        bunExecutable: join(fakeTools, "bun"),
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

  test("verifies the installed Claude package identity without launching the CLI", async () => {
    const run = await runColdClaudeBootstrap((home) => `#!/bin/sh
printf launched > ${JSON.stringify(join(home, "version-count"))}
exit 17
`);
    try {
      expect(run.result.exitCode).toBe(0);
      expect(await Bun.file(run.versionCountPath).exists()).toBe(false);
    } finally {
      await rm(run.home, { recursive: true, force: true });
    }
  });

  test("verifies the installed OpenCode package identity without launching the CLI", async () => {
    const run = await runColdOpenCodeBootstrap();
    try {
      expect(run.result.exitCode).toBe(0);
      expect(await Bun.file(run.launchMarker).exists()).toBe(false);
      expect(buildOpenCodeInstallIdentityProbeCommand({
        home: run.home,
        workdir: join(run.home, "work"),
        runsAsRoot: false,
      })).not.toContain("--version");
    } finally {
      await rm(run.home, { recursive: true, force: true });
    }
  });

  test("rejects a post-install OpenCode package with the wrong exact version", async () => {
    const run = await runColdOpenCodeBootstrap("1.18.6");
    try {
      expect(run.result.exitCode).toBe(1);
      const output = `${run.result.stdout?.toString() ?? ""}${run.result.stderr?.toString() ?? ""}`;
      expect(output).toContain(
        "useagent-native-version-probe: install_identity_mismatch expected=1.18.7",
      );
      expect(output.length).toBeLessThan(160);
    } finally {
      await rm(run.home, { recursive: true, force: true });
    }
  });

  test("rejects the executable placeholder shipped before OpenCode postinstall", async () => {
    const run = await runColdOpenCodeBootstrap("1.18.7", Buffer.from(openCodePostinstallPlaceholder));
    try {
      expect(Buffer.byteLength(openCodePostinstallPlaceholder)).toBe(479);
      expect(run.result.exitCode).toBe(1);
      expect(run.result.stderr?.toString() ?? "").toContain("install_identity_mismatch expected=1.18.7");
      expect(await Bun.file(run.launchMarker).exists()).toBe(false);
    } finally {
      await rm(run.home, { recursive: true, force: true });
    }
  });

  test.each(["placeholder", "wrong-target"] as const)("repairs an OpenCode %s mutation before startup", async (mutation) => {
    const run = await runColdOpenCodeBootstrap();
    try {
      expect(run.result.exitCode).toBe(0);
      const packageDir = join(run.home, ".local/share/useagent/native-engines/node_modules/opencode-ai");
      const launcher = join(run.home, ".local/bin/opencode");
      if (mutation === "placeholder") {
        await Bun.write(join(packageDir, "bin/opencode.exe"), openCodePostinstallPlaceholder);
      } else {
        const other = join(packageDir, "bin/not-opencode");
        await Bun.write(other, nativeElfHeaderFixture);
        await Bun.$`chmod 700 ${other}`;
        await unlink(launcher);
        await symlink(other, launcher);
      }
      const layout = {
        home: run.home, workdir: join(run.home, "work"), runsAsRoot: false,
        bunExecutable: join(run.home, "fake-tools/bun"),
      };
      const probe = buildOpenCodeInstallIdentityProbeCommand(layout, true);
      expect(Bun.spawnSync(["/bin/sh", "-c", probe]).exitCode).toBe(1);
      const repair = buildRuntimeProviderBootstrapCommand("opencode", {}, layout);
      expect(Bun.spawnSync(["/bin/sh", "-c", repair]).exitCode).toBe(0);
      expect(Bun.spawnSync(["/bin/sh", "-c", probe]).exitCode).toBe(0);
    } finally {
      await rm(run.home, { recursive: true, force: true });
    }
  });

  test("rejects a post-install Claude package with the wrong exact version", async () => {
    const run = await runColdClaudeBootstrap(() => "#!/bin/sh\nexit 0\n", "2.1.225");
    try {
      expect(run.result.exitCode).toBe(1);
      const output = `${run.result.stdout?.toString() ?? ""}${run.result.stderr?.toString() ?? ""}`;
      expect(output).toContain(
        "useagent-native-version-probe: install_identity_mismatch expected=2.1.226",
      );
      expect(output.length).toBeLessThan(160);
    } finally {
      await rm(run.home, { recursive: true, force: true });
    }
  });

  test("repairs an executable outside the verified Claude package and advances the fence", async () => {
    const run = await runColdClaudeBootstrap(() => "#!/bin/sh\nexit 0\n");
    try {
      expect(run.result.exitCode).toBe(0);
      const marker = join(run.home, ".skynet/t3/caches/useagent-claude-bootstrap");
      const firstFence = Number(await readFile(marker, "utf8"));
      const launcher = join(run.home, ".local/bin/claude");
      await rm(launcher);
      await Bun.write(launcher, "#!/bin/sh\nexit 0\n");
      await Bun.$`chmod 700 ${launcher}`;
      const fakeTools = join(run.home, "fake-tools");
      await Bun.sleep(2);
      const command = buildRuntimeProviderBootstrapCommand("claude", {
        ANTHROPIC_BASE_URL: "https://gateway.example.test/provider/anthropic",
        CLAUDE_CONFIG_DIR: join(run.home, "claude-config"),
      }, {
        home: run.home,
        workdir: join(run.home, "work"),
        runsAsRoot: false,
        bunExecutable: join(fakeTools, "bun"),
      });
      const result = Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { ...process.env, HOME: run.home },
      });
      expect(result.exitCode).toBe(0);
      const packageRoot = await realpath(
        join(run.home, ".local/share/useagent/native-engines/node_modules/@anthropic-ai/claude-code"),
      );
      expect((await realpath(launcher)).startsWith(packageRoot)).toBe(true);
      expect(Number(await readFile(marker, "utf8"))).toBeGreaterThan(firstFence);
    } finally {
      await rm(run.home, { recursive: true, force: true });
    }
  });

  test("accepts only fresh authoritative T3 Claude health", async () => {
    const home = await mkdtemp(join(tmpdir(), "skynet-t3-claude-ready-"));
    try {
      const cachePath = join(home, ".skynet/t3/caches/claudeAgent.json");
      const markerPath = join(home, ".skynet/t3/caches/useagent-claude-bootstrap");
      await mkdir(join(home, ".skynet/t3/caches"), { recursive: true });
      await Bun.write(markerPath, String(Date.parse("2026-09-05T00:00:10.000Z")));
      const readiness = claudeProviderReadiness(claudeEnvironment);
      const command = buildRuntimeProviderReadyProbeCommand(readiness);
      const runProbe = () => Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { ...process.env, HOME: home },
      }).exitCode;
      const ready = {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: readiness.displayName,
        enabled: true,
        installed: true,
        version: "2.1.226",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-09-05T00:00:11.000Z",
      } as const;

      for (const rejected of [
        { ...ready, displayName: "UseAgent Claude gateway stale" },
        { ...ready, installed: false, status: "warning", auth: { status: "unknown" } },
        { ...ready, version: "2.1.225" },
        { ...ready, auth: { status: "unauthenticated" } },
        { ...ready, checkedAt: "2026-09-05T00:00:09.000Z" },
        { ...ready, availability: "unavailable" },
      ]) {
        await Bun.write(cachePath, JSON.stringify(rejected));
        expect(runProbe()).not.toBe(0);
      }

      await Bun.write(cachePath, JSON.stringify(ready));
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

    const bootstraps = commands.filter((command) => command.includes("NATIVE_PACKAGE="));
    expect(bootstraps).toHaveLength(3);
    expect(bootstraps[0]).toContain("@openai/codex@0.153.3");
    expect(bootstraps[1]).toContain("@anthropic-ai/claude-code@2.1.226");
    expect(bootstraps[2]).toContain("opencode-ai@1.18.7");
  });

  test("prepares only the selected stable provider without a run-bound lease", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "fresh-selected-provider",
      providerKind: "cube",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;
    const context = {
      runId: "run-selected-provider",
      threadId: "thread-selected-provider",
      prompt: "work",
      bootstrapContext: "",
      turnContext: "",
      workdir: "/root/work",
      orgId: "org-a",
      userId: "user-a",
      model: "gpt-5.6-luna",
      signal: new AbortController().signal,
      emit: async () => undefined,
      setSummary: () => undefined,
    } as const;

    await expect(
      prepareStableRuntimeProvider(sandbox, context, "codex"),
    ).resolves.toBeUndefined();

    const bootstraps = commands.filter((command) => command.includes("NATIVE_PACKAGE="));
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]).toContain("@openai/codex@0.153.3");
    expect(bootstraps[0]).not.toContain("providerInstances");
    expect(commands.some((command) => command.includes("exec-server"))).toBe(false);
    expect(commands.some((command) => command.includes("codex-relay"))).toBe(false);
  });

  test("batches retained Codex Bun and package identity validation and repairs tampering", async () => {
    const commands: string[] = [];
    let identityValid = true;
    let bootstraps = 0;
    const layout = {
      home: "/home/user",
      workdir: "/home/user/work",
      runsAsRoot: false,
      bunExecutable: "/usr/local/bin/bun",
    } as const;
    const identityCommand = buildCodexInstallIdentityProbeCommand(layout);
    const sandbox = {
      id: "box-cached-codex-identity",
      providerKind: "box",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (command.includes('NATIVE_PACKAGE="@openai/codex@0.153.3"')) {
            bootstraps += 1;
            identityValid = true;
            return { exitCode: 0, result: "" };
          }
          if (command.includes(identityCommand)) {
            expect(command).toContain(buildSandboxBunProbeCommand(layout));
            return { exitCode: identityValid ? 0 : 1, result: "" };
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;
    const context = {
      runId: "run-box-codex-identity",
      threadId: "thread-box-codex-identity",
      prompt: "work",
      bootstrapContext: "",
      turnContext: "",
      workdir: "/home/user/work",
      orgId: "org-a",
      userId: "user-a",
      model: "gpt-5.6-luna",
      signal: new AbortController().signal,
      emit: async () => undefined,
      setSummary: () => undefined,
    } as const;

    await prepareStableRuntimeProvider(sandbox, context, "codex");
    const afterCold = commands.length;
    await prepareStableRuntimeProvider(sandbox, context, "codex");
    expect(commands.slice(afterCold)).toHaveLength(1);
    expect(bootstraps).toBe(1);

    identityValid = false;
    await prepareStableRuntimeProvider(sandbox, context, "codex");
    expect(bootstraps).toBe(2);
  });

  test("does not repeat stable bootstrap inside the same fresh turn preparation", async () => {
    const commands: string[] = [];
    const sandbox = {
      id: "fresh-opencode-one-bootstrap",
      providerKind: "box",
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;
    const context = {
      runId: "run-fresh-one-bootstrap",
      threadId: "thread-fresh-one-bootstrap",
      prompt: "work",
      bootstrapContext: "",
      turnContext: "",
      workdir: "/home/user/work",
      orgId: "org-a",
      userId: "user-a",
      model: "openai/gpt-5.6-luna",
      signal: new AbortController().signal,
      emit: async () => undefined,
      setSummary: () => undefined,
    } as const;

    await prepareStableRuntimeProvider(sandbox, context, "opencode");
    await prepareRuntimeProviderBridge(
      sandbox,
      context,
      "opencode",
      "/home/user/work",
      true,
    );

    expect(commands.filter((command) => command.includes('NATIVE_PACKAGE="opencode-ai@1.18.7"')))
      .toHaveLength(1);
    expect(commands.filter((command) =>
      command.includes(buildOpenCodeInstallIdentityProbeCommand({
        home: "/home/user",
        workdir: "/home/user/work",
        runsAsRoot: false,
      }))
    )).toHaveLength(1);
  });

  test.each(["claude", "opencode"] as const)("revalidates cached %s identity and repairs only after mutation", async (engine) => {
    let identityValid = true;
    let bootstrapSucceeds = true;
    let fullBootstraps = 0;
    let identityProbes = 0;
    let fenceGeneration = 0;
    let capabilityRefreshes = 0;
    const identityCommand = (engine === "claude"
      ? buildClaudeInstallIdentityProbeCommand
      : buildOpenCodeInstallIdentityProbeCommand)({
      home: "/home/user",
      workdir: "/home/user/work",
      runsAsRoot: false,
    });
    const sandbox = {
      id: `box-cached-${engine}-identity`,
      providerKind: "box",
      process: {
        executeCommand: async (command: string) => {
          const nativePackage = engine === "claude"
            ? '@anthropic-ai/claude-code@2.1.226'
            : 'opencode-ai@1.18.7';
          if (command.includes(`NATIVE_PACKAGE="${nativePackage}"`)) {
            fullBootstraps += 1;
            if (!bootstrapSucceeds) return { exitCode: 1, result: "" };
            identityValid = true;
            fenceGeneration += 1;
            return { exitCode: 0, result: "" };
          }
          if (command.includes(identityCommand)) {
            identityProbes += 1;
            expect(command).toContain(buildSandboxBunProbeCommand({
              home: "/home/user",
              workdir: "/home/user/work",
              runsAsRoot: false,
              bunExecutable: "/usr/local/bin/bun",
            }));
            return { exitCode: identityValid ? 0 : 1, result: "" };
          }
          if (command.includes("provider-gateway-generation")) {
            capabilityRefreshes += 1;
          }
          return { exitCode: 0, result: "" };
        },
      },
    } as unknown as SandboxHandle;
    const context = {
      runId: "run-box-identity",
      threadId: "thread-box-identity",
      prompt: "work",
      bootstrapContext: "",
      turnContext: "",
      workdir: "/home/user/work",
      orgId: "org-a",
      userId: "user-a",
      model: engine === "claude" ? "claude-fable-5" : "openai/gpt-5.6-luna",
      signal: new AbortController().signal,
      emit: async () => undefined,
      setSummary: () => undefined,
    } as const;

    await prepareRuntimeProviderBridge(sandbox, context, engine, "/home/user/work");
    expect({ fullBootstraps, identityProbes, fenceGeneration }).toEqual({
      fullBootstraps: 1,
      identityProbes: 0,
      fenceGeneration: 1,
    });

    await prepareRuntimeProviderBridge(sandbox, context, engine, "/home/user/work");
    expect({ fullBootstraps, identityProbes, fenceGeneration }).toEqual({
      fullBootstraps: 1,
      identityProbes: 1,
      fenceGeneration: 1,
    });

    identityValid = false;
    await prepareRuntimeProviderBridge(sandbox, context, engine, "/home/user/work");
    expect({ fullBootstraps, identityProbes, fenceGeneration }).toEqual({
      fullBootstraps: 2,
      identityProbes: 2,
      fenceGeneration: 2,
    });

    await prepareRuntimeProviderBridge(sandbox, context, engine, "/home/user/work");
    expect({ fullBootstraps, identityProbes, fenceGeneration }).toEqual({
      fullBootstraps: 2,
      identityProbes: 3,
      fenceGeneration: 2,
    });

    identityValid = false;
    bootstrapSucceeds = false;
    await expect(
      prepareRuntimeProviderBridge(sandbox, context, engine, "/home/user/work"),
    ).rejects.toThrow(`native ${engine} runtime bootstrap failed`);
    expect(fenceGeneration).toBe(2);
    expect(capabilityRefreshes).toBe(4);
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
        executeCommand: async (command: string) => {
          if (command.includes("--version)\" = '1.3.14'")) return { exitCode: 0, result: "" };
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

  test("surfaces only an allowlisted bounded bootstrap diagnostic", async () => {
    const secret = "signed-gateway-capability";
    const sandbox = {
      id: "t3-provider-safe-diagnostic",
      process: {
        executeCommand: async (command: string) => command.includes("--version)\" = '1.3.14'")
          ? { exitCode: 0, result: "" }
          : ({
          exitCode: 1,
          result: `${secret.repeat(100)}\nuseagent-native-version-probe: probe_failed attempts=3 last_status=7 error=none\n${secret}`,
          }),
      },
    } as unknown as SandboxHandle;

    let failure: unknown;
    try {
      await prewarmRuntimeProviderBridge(sandbox, { T3_ENVIRONMENT_ENABLED: "true" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(
      "useagent-native-version-probe: probe_failed attempts=3 last_status=7 error=none",
    );
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThan(160);
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
