import { LEGACY_TOOL_SERVER_IDS } from "@useagent/agent-harness/canonical";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "../sandboxes/provider";
import type { EngineRunContext } from "../engines/types";
import {
  mergeOpenCodeProviderConfig,
  opencodeProviderGatewayOptions,
  providerGatewayEnv,
  providerGatewaySandboxLabels,
  providerGatewaySandboxIsCurrent,
  providerGatewayWired,
  prepareProviderGatewaySandbox,
  codexProviderConfigToml,
  buildClaudeCapabilityWriteCommand,
  CANONICAL_SANDBOX_GENERATION_LABEL,
  readCompatibleSandboxLabel,
  SANDBOX_GENERATION,
} from "./sandbox-config";
import { verifyProviderToken } from "./token";
import { OPENCODE_ALLOWED_MODELS } from "../runs/model-policy";
import { verifyToolToken } from "../knowledge/gateway/token";
import { TOOL_GATEWAY_SERVER_NAME } from "../knowledge/gateway/descriptor";
import { LEGACY_SANDBOX_GENERATION_LABEL, LEGACY_SANDBOX_RUN_LABEL } from "../sandboxes/label-compat";
import { SANDBOX_NAME_PREFIX, SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";

const original = { ...process.env };

afterEach(() => {
  for (const name of [
    "PROVIDER_GATEWAY_PUBLIC_URL",
    "GATEWAY_PUBLIC_URL",
    "TOOL_GATEWAY_PUBLIC_URL",
    "PROVIDER_GATEWAY_TOKEN_TTL_MS",
    "TOOL_GATEWAY_TOKEN_TTL_MS",
    "PROVIDER_GATEWAY_SECRET",
    "TOOL_GATEWAY_SECRET",
    "NODE_ENV",
    "USEAGENT_DEV_MODE",
    "SANDBOX_SECRET_MODE",
  ]) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function ctx(): EngineRunContext {
  return {
    runId: "run-a",
    prompt: "x",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/work",
    threadId: "thread-a",
    orgId: "org-a",
    userId: "user-a",
    model: "claude-opus-5",
    signal: new AbortController().signal,
    emit: async () => undefined,
    setSummary: () => {},
  };
}

function recordingSandbox(): {
  readonly sandbox: SandboxHandle;
  readonly files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  const sandbox = {
    process: {
      executeCommand: async (command: string) => {
        for (const match of command.matchAll(/printf %s '([^']+)' \| base64 -d > ([^ ]+)/g)) {
          files[match[2]!] = Buffer.from(match[1]!, "base64").toString("utf8");
        }
        for (const match of command.matchAll(
          /renameSync\(process\.argv\[1\],process\.argv\[2\]\)'\s+([^ ]+)\s+([^ &]+)/g,
        )) {
          files[match[2]!] = files[match[1]!]!;
        }
        return { exitCode: 0, result: "" };
      },
    },
  } as unknown as SandboxHandle;
  return { sandbox, files };
}

function localShellSandbox(root: string): SandboxHandle {
  return {
    process: {
      executeCommand: async (command: string) => {
        const result = Bun.spawnSync(["/bin/sh", "-c", command.replaceAll("$HOME", root)], {
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exitCode: result.exitCode,
          result: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      },
    },
  } as unknown as SandboxHandle;
}

function privateWriterContext(runId: string): EngineRunContext {
  const context = ctx();
  context.runId = runId;
  context.threadId = undefined;
  context.model = "gpt-5.6-sol";
  return context;
}

function mode(value: number): number {
  return value & 0o777;
}

function expectLifetime(
  exp: number,
  mintedBetween: readonly [number, number],
  ttlMs: number,
): void {
  expect(exp).toBeGreaterThanOrEqual(mintedBetween[0] + ttlMs);
  expect(exp).toBeLessThanOrEqual(mintedBetween[1] + ttlMs);
}

describe("sandbox provider gateway config", () => {
  test("refreshes the Codex capability and drops a stale login in one command", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    const root = await mkdtemp(join(tmpdir(), "useagent-provider-one-command-"));
    const shell = localShellSandbox(root);
    const commands: string[] = [];
    const sandbox = {
      process: {
        executeCommand: async (command: string, ...rest: unknown[]) => {
          commands.push(command);
          return (shell.process.executeCommand as (c: string, ...r: unknown[]) => Promise<unknown>)(command, ...rest);
        },
      },
    } as unknown as SandboxHandle;
    try {
      await mkdir(join(root, ".codex"), { recursive: true });
      await writeFile(join(root, ".codex", "auth.json"), "{}");
      await prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-one-command"), "codex");
      expect(commands).toHaveLength(1);
      expect(await Bun.file(join(root, ".codex", "auth.json")).exists()).toBe(false);
      expect(await Bun.file(join(root, ".codex", "config.toml")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates and refreshes private files without disturbing app state", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    const root = await mkdtemp(join(tmpdir(), "useagent-provider-private-writer-"));
    const sandbox = localShellSandbox(root);
    const canonicalDir = join(root, ".useagent");
    const legacyDir = join(root, SANDBOX_STATE_DIR);
    const canonicalToken = join(canonicalDir, "provider-openai.token");
    const legacyToken = join(legacyDir, "provider-openai.token");
    const canonicalMarker = join(canonicalDir, "provider-gateway-generation");
    const legacyMarker = join(legacyDir, "provider-gateway-generation");
    try {
      await mkdir(legacyDir, { mode: 0o711 });
      await writeFile(legacyToken, "legacy-token");
      await writeFile(legacyMarker, SANDBOX_GENERATION);
      expect(Bun.spawnSync(["/bin/sh", "-c", `cat '${legacyToken}'`]).stdout.toString())
        .toBe("legacy-token");
      await prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-first"), "codex");

      expect(mode((await stat(canonicalDir)).mode)).toBe(0o700);
      expect(mode((await stat(legacyDir)).mode)).toBe(0o711);
      expect((await lstat(canonicalToken)).isFile()).toBe(true);
      expect((await lstat(canonicalToken)).isSymbolicLink()).toBe(false);
      expect(mode((await stat(canonicalToken)).mode)).toBe(0o600);
      expect(mode((await stat(canonicalMarker)).mode)).toBe(0o600);
      expect(await readlink(legacyToken)).toBe("../.useagent/provider-openai.token");
      expect(await readlink(legacyMarker)).toBe("../.useagent/provider-gateway-generation");
      expect(await readFile(canonicalMarker, "utf8")).toBe(SANDBOX_GENERATION);
      expect(Bun.spawnSync(["/bin/sh", "-c", `cat '${legacyToken}'`]).stdout.toString())
        .toBe(await readFile(canonicalToken, "utf8"));

      await chmod(canonicalDir, 0o751);
      await chmod(legacyDir, 0o711);
      const canonicalOwner = await stat(canonicalDir);
      const legacyOwner = await stat(legacyDir);
      await writeFile(join(canonicalDir, "pi-state"), "pi-unchanged");
      await writeFile(join(legacyDir, "broker-state"), "broker-unchanged");
      await writeFile(join(root, "output-sentinel"), "output-unchanged");
      const rollback = Bun.spawnSync([
        "/bin/sh",
        "-c",
        `printf %s rollback-refresh > '${legacyToken}' && chmod 600 '${legacyToken}'`,
      ]);
      expect(rollback.exitCode).toBe(0);
      expect(await readFile(canonicalToken, "utf8")).toBe("rollback-refresh");

      await prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-second"), "codex");

      expect(await readFile(canonicalToken, "utf8")).not.toBe("rollback-refresh");
      expect(Bun.spawnSync(["/bin/sh", "-c", `cat '${legacyToken}'`]).stdout.toString())
        .toBe(await readFile(canonicalToken, "utf8"));
      expect(mode((await stat(canonicalDir)).mode)).toBe(0o751);
      expect(mode((await stat(legacyDir)).mode)).toBe(0o711);
      expect((await stat(canonicalDir)).uid).toBe(canonicalOwner.uid);
      expect((await stat(canonicalDir)).gid).toBe(canonicalOwner.gid);
      expect((await stat(legacyDir)).uid).toBe(legacyOwner.uid);
      expect((await stat(legacyDir)).gid).toBe(legacyOwner.gid);
      expect(await readFile(join(canonicalDir, "pi-state"), "utf8")).toBe("pi-unchanged");
      expect(await readFile(join(legacyDir, "broker-state"), "utf8")).toBe("broker-unchanged");
      expect(await readFile(join(root, "output-sentinel"), "utf8")).toBe("output-unchanged");
      expect(await readFile(canonicalMarker, "utf8")).toBe(SANDBOX_GENERATION);
      expect((await readdir(canonicalDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect((await readdir(legacyDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

      const freshRoot = await mkdtemp(join(root, "fresh-parents-"));
      await prepareProviderGatewaySandbox(
        localShellSandbox(freshRoot),
        privateWriterContext("writer-fresh-parents"),
        "codex",
      );
      expect(mode((await stat(join(freshRoot, ".useagent"))).mode)).toBe(0o700);
      expect(mode((await stat(join(freshRoot, SANDBOX_STATE_DIR))).mode)).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces leaf symlinks without following them and rejects directories", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const root = await mkdtemp(join(tmpdir(), "useagent-provider-private-leaves-"));
    const canonicalDir = join(root, ".useagent");
    const legacyDir = join(root, SANDBOX_STATE_DIR);
    const canonicalToken = join(canonicalDir, "provider-openai.token");
    const legacyToken = join(legacyDir, "provider-openai.token");
    const canonicalVictim = join(root, "canonical-victim");
    const legacyVictim = join(root, "legacy-victim");
    const sandbox = localShellSandbox(root);
    try {
      await mkdir(canonicalDir);
      await mkdir(legacyDir);
      await writeFile(canonicalVictim, "canonical-unchanged");
      await writeFile(legacyVictim, "legacy-unchanged");
      await symlink(canonicalVictim, canonicalToken);
      await symlink(legacyVictim, legacyToken);

      await prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-symlinks"), "codex");
      expect(await readFile(canonicalVictim, "utf8")).toBe("canonical-unchanged");
      expect(await readFile(legacyVictim, "utf8")).toBe("legacy-unchanged");
      expect((await lstat(canonicalToken)).isSymbolicLink()).toBe(false);
      expect(await readlink(legacyToken)).toBe("../.useagent/provider-openai.token");

      await rm(canonicalToken);
      await mkdir(canonicalToken);
      await expect(prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-canonical-dir"), "codex"))
        .rejects.toThrow("failed to configure provider gateway");
      await rm(canonicalToken, { recursive: true });
      await writeFile(canonicalToken, "repairable");
      await rm(legacyToken);
      await mkdir(legacyToken);
      await expect(prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-legacy-dir"), "codex"))
        .rejects.toThrow("failed to configure provider gateway");
      await rm(legacyToken, { recursive: true });
      await writeFile(legacyToken, "independent-legacy-copy");
      await prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-two-copies"), "codex");
      expect(await readFile(canonicalToken, "utf8")).not.toBe("repairable");
      expect(await readlink(legacyToken)).toBe("../.useagent/provider-openai.token");
      expect(Bun.spawnSync(["/bin/sh", "-c", `cat '${legacyToken}'`]).stdout.toString())
        .toBe(await readFile(canonicalToken, "utf8"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects parent aliases and safely repairs a partial namespace", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    const root = await mkdtemp(join(tmpdir(), "useagent-provider-private-repair-"));
    const sandbox = localShellSandbox(root);
    const canonicalDir = join(root, ".useagent");
    const legacyDir = join(root, SANDBOX_STATE_DIR);
    const canonicalToken = join(canonicalDir, "provider-openai.token");
    const legacyToken = join(legacyDir, "provider-openai.token");
    const canonicalMarker = join(canonicalDir, "provider-gateway-generation");
    const codexConfig = join(root, ".codex", "config.toml");
    try {
      await mkdir(canonicalDir);
      await mkdir(legacyDir);
      await writeFile(canonicalToken, "partial-token");
      await symlink("../.useagent/provider-openai.token", legacyToken);
      await mkdir(join(root, ".codex"));
      await mkdir(codexConfig);

      await expect(prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-partial"), "codex"))
        .rejects.toThrow("failed to configure provider gateway");
      expect(await readFile(canonicalToken, "utf8")).not.toBe("partial-token");
      expect(await lstat(canonicalMarker).then(() => true).catch(() => false)).toBe(false);
      expect((await readdir(canonicalDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect((await readdir(legacyDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      await rm(codexConfig, { recursive: true });
      await prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-repair"), "codex");
      expect(await readFile(canonicalMarker, "utf8")).toBe(SANDBOX_GENERATION);
      await rm(canonicalMarker);
      await mkdir(canonicalMarker);
      await expect(prepareProviderGatewaySandbox(sandbox, privateWriterContext("writer-marker-dir"), "codex"))
        .rejects.toThrow("failed to configure provider gateway");

      for (const parent of [canonicalDir, legacyDir]) {
        const aliasRoot = await mkdtemp(join(root, "parent-alias-"));
        const victim = join(aliasRoot, "victim");
        await mkdir(victim);
        await writeFile(join(victim, "sentinel"), "unchanged");
        await symlink(victim, join(aliasRoot, parent === canonicalDir ? ".useagent" : SANDBOX_STATE_DIR));
        await expect(prepareProviderGatewaySandbox(
          localShellSandbox(aliasRoot),
          privateWriterContext(`writer-parent-${parent}`),
          "codex",
        )).rejects.toThrow("failed to configure provider gateway");
        expect(await readFile(join(victim, "sentinel"), "utf8")).toBe("unchanged");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("private provider readers prefer present canonical files and fail closed", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    const root = await mkdtemp(join(tmpdir(), "useagent-provider-private-reader-"));
    try {
      const legacyDir = join(root, SANDBOX_STATE_DIR);
      const canonicalDir = join(root, ".useagent");
      await mkdir(legacyDir);
      await mkdir(canonicalDir);
      const legacyToken = join(legacyDir, "provider-openai.token");
      const canonicalToken = join(canonicalDir, "provider-openai.token");
      await writeFile(legacyToken, "legacy-token");
      const config = codexProviderConfigToml("gpt-5.6-sol");
      const encodedCommand = config?.match(/^args = \["-c", (.+)\]$/m)?.[1];
      if (!encodedCommand) throw new Error("missing Codex auth command");
      const authCommand = (JSON.parse(encodedCommand) as string).replaceAll("$HOME", root);
      const run = () => Bun.spawnSync(["sh", "-c", authCommand], { stdout: "pipe", stderr: "pipe" });
      expect(run().stdout.toString()).toBe("legacy-token");
      await writeFile(canonicalToken, "canonical-token");
      expect(run().stdout.toString()).toBe("canonical-token");
      await chmod(canonicalToken, 0o000);
      if (process.getuid?.() !== 0) {
        const unreadable = run();
        expect(unreadable.exitCode).not.toBe(0);
        expect(unreadable.stdout.toString()).toBe("");
      }
      await chmod(canonicalToken, 0o600);
      await writeFile(canonicalToken, "");
      const empty = run();
      expect(empty.exitCode).not.toBe(0);
      expect(empty.stdout.toString()).toBe("");
      await rm(canonicalToken, { recursive: true });
      await mkdir(canonicalToken);
      const directory = run();
      expect(directory.exitCode).not.toBe(0);
      expect(directory.stdout.toString()).toBe("");
      await rm(canonicalToken, { recursive: true });
      await symlink(join(canonicalDir, "missing-token"), canonicalToken);
      const dangling = run();
      expect(dangling.exitCode).not.toBe(0);
      expect(dangling.stdout.toString()).toBe("");

      const canonicalMarker = join(canonicalDir, "provider-gateway-generation");
      const legacyMarker = join(legacyDir, "provider-gateway-generation");
      await rm(canonicalToken);
      await writeFile(legacyMarker, SANDBOX_GENERATION);
      const sandbox = {
        labels: { [CANONICAL_SANDBOX_GENERATION_LABEL]: SANDBOX_GENERATION },
        process: {
          executeCommand: async (command: string) => {
            const result = Bun.spawnSync(["sh", "-c", command.replaceAll("$HOME", root)]);
            return { exitCode: result.exitCode };
          },
        },
      } as unknown as SandboxHandle;
      expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(true);
      await writeFile(canonicalMarker, SANDBOX_GENERATION);
      expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(true);
      await writeFile(canonicalMarker, "");
      expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(false);
      await writeFile(canonicalMarker, "invalid-generation");
      expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads legacy and canonical label aliases only when they agree", () => {
    expect(readCompatibleSandboxLabel({}, "useagent-key", "legacy-key")).toEqual({
      value: null,
      conflict: false,
    });
    expect(readCompatibleSandboxLabel({ "legacy-key": "value" }, "useagent-key", "legacy-key"))
      .toEqual({ value: "value", conflict: false });
    expect(readCompatibleSandboxLabel({ "useagent-key": "value" }, "useagent-key", "legacy-key"))
      .toEqual({ value: "value", conflict: false });
    expect(readCompatibleSandboxLabel(
      { "useagent-key": "value", "legacy-key": "value" },
      "useagent-key",
      "legacy-key",
    )).toEqual({ value: "value", conflict: false });
    expect(readCompatibleSandboxLabel(
      { "useagent-key": "new", "legacy-key": "old" },
      "useagent-key",
      "legacy-key",
    )).toEqual({ value: null, conflict: true });
  });

  test("is inert when no sandbox-reachable gateway exists", () => {
    delete process.env.PROVIDER_GATEWAY_PUBLIC_URL;
    delete process.env.GATEWAY_PUBLIC_URL;
    delete process.env.TOOL_GATEWAY_PUBLIC_URL;
    expect(providerGatewayWired()).toBe(false);
    expect(providerGatewayEnv(ctx(), "claude")).toEqual({});
  });

  test("does not accept the legacy full-backend tunnel variable", () => {
    delete process.env.PROVIDER_GATEWAY_PUBLIC_URL;
    delete process.env.GATEWAY_PUBLIC_URL;
    process.env.TOOL_GATEWAY_PUBLIC_URL = "https://full-backend.example.test";
    expect(providerGatewayWired()).toBe(false);
  });

  test("Claude uses a dynamic key helper and Codex uses command-backed auth", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test/";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const claude = providerGatewayEnv(ctx(), "claude");
    expect(claude.ANTHROPIC_BASE_URL).toBe("https://gateway.example.test/api/provider/anthropic");
    expect(claude.CLAUDE_CONFIG_DIR).toBe(`/tmp/${SANDBOX_NAME_PREFIX}-claude-config`);
    expect(claude).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(claude).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(claude.ANTHROPIC_MODEL).toBe("claude-opus-5[1m]");
    expect(claude.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-opus-5[1m]");
    expect(claude.CLAUDE_CODE_API_KEY_HELPER_TTL_MS).toBe("1");

    const codex = providerGatewayEnv(ctx(), "codex");
    expect(codex).toEqual({});
    const config = codexProviderConfigToml(
      "gpt-5.6-sol",
      { url: "https://gateway.example.test/api/mcp/knowledge", bearerToken: "tool-token" },
    );
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).toContain(`model_provider = "${SANDBOX_NAME_PREFIX}"`);
    expect(config).toContain('sandbox_mode = "danger-full-access"');
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain(
      'base_url = "https://gateway.example.test/api/provider/openai/v1"',
    );
    expect(config).toContain(`[model_providers.${SANDBOX_NAME_PREFIX}.auth]`);
    expect(config).toContain('command = "sh"');
    expect(config).not.toContain("env_key");
    expect(config).toContain(`[mcp_servers.${TOOL_GATEWAY_SERVER_NAME}]`);
    expect(config).not.toContain(`mcp_servers.${LEGACY_TOOL_SERVER_IDS.gateway}`);
    expect(config).toContain('url = "https://gateway.example.test/api/mcp/knowledge"');
    expect(config).toContain('http_headers = { Authorization = "Bearer tool-token" }');
    expect(config).toContain("enabled = true");
    expect(config).toContain("required = true");
  });

  test("Claude receives a private thread-scoped knowledge MCP capability", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const { sandbox, files } = recordingSandbox();

    await prepareProviderGatewaySandbox(sandbox, ctx(), "claude");

    const mcpConfig = JSON.parse(
      files["/tmp/useagent-claude-capability/useagent-mcp.json"]!,
    ) as {
      mcpServers: Record<
        string,
        { type: string; url: string; headers: { Authorization: string } }
      >;
    };
    const knowledge = mcpConfig.mcpServers[TOOL_GATEWAY_SERVER_NAME]!;
    expect(knowledge).toMatchObject({
      type: "http",
      url: "https://gateway.example.test/api/mcp/knowledge",
    });
    const bearerToken = knowledge.headers.Authorization.replace(/^Bearer /, "");
    expect(verifyToolToken(bearerToken)).toMatchObject({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
      scope: "thread",
    });
    expect(files["/tmp/useagent-claude-capability/useagent-settings.json"]).not.toContain(bearerToken);
    expect(files["/tmp/useagent-claude-capability/useagent-settings.json"]).not.toContain(
      process.env.TOOL_GATEWAY_SECRET!,
    );
    expect(files["/tmp/useagent-claude-capability/useagent-mcp.json"]).not.toContain(
      process.env.TOOL_GATEWAY_SECRET!,
    );
  });

  test("atomically replaces a symlinked Claude capability without following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-claude-capability-"));
    const directory = join(root, "capability");
    const tokenPath = join(directory, "provider.token");
    const victimPath = join(root, "victim");
    try {
      await mkdir(directory);
      await writeFile(victimPath, "unchanged");
      await symlink(victimPath, tokenPath);
      const result = Bun.spawnSync([
        "/bin/sh",
        "-c",
        buildClaudeCapabilityWriteCommand(
          directory,
          [{ path: tokenPath, content: "scoped-capability" }],
          process.getuid?.() ?? 0,
          process.getgid?.() ?? 0,
        ),
      ]);

      expect(result.exitCode).toBe(0);
      expect(await readFile(victimPath, "utf8")).toBe("unchanged");
      expect(await readFile(tokenPath, "utf8")).toBe("scoped-capability");
      expect((await lstat(tokenPath)).isSymbolicLink()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Claude warm replies reuse a user-bound thread provider capability", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-claude-warm-provider";
    first.runId = "run-claude-warm-a";
    const second = ctx();
    second.threadId = first.threadId;
    second.runId = "run-claude-warm-b";
    const { sandbox, files } = recordingSandbox();

    await prepareProviderGatewaySandbox(sandbox, first, "claude");
    const firstToken = files["/tmp/useagent-claude-capability/provider-anthropic.token"];
    await prepareProviderGatewaySandbox(sandbox, second, "claude");
    const secondToken = files["/tmp/useagent-claude-capability/provider-anthropic.token"];

    expect(secondToken).toBe(firstToken);
    expect(verifyProviderToken(secondToken)).toMatchObject({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-claude-warm-provider",
      issuedRunId: "run-claude-warm-a",
      engine: "claude",
      provider: "anthropic",
      scope: "thread",
    });
  });

  test("Claude's settings name the run's model in every slot, cap output under the gateway ceiling and refresh the helper", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const settingsOf = async (model: string) => {
      const run = ctx();
      run.threadId = `thread-claude-settings-${model}`;
      run.model = model;
      const { sandbox, files } = recordingSandbox();
      await prepareProviderGatewaySandbox(sandbox, run, "claude");
      const settings = JSON.parse(files["/tmp/useagent-claude-capability/useagent-settings.json"]!) as { env?: Record<string, string> };
      expect(files["/tmp/useagent-claude-capability/settings.json"]).toBe(JSON.stringify(settings));
      return settings;
    };

    // The native wrapper exports only the gateway URL and config dir, so the slots
    // ride the settings: otherwise Claude Code's Haiku helper and subagent calls ask
    // for another model, which the gateway refuses.
    const slots = (model: string) => ({
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    });
    // Claude Code asks 128K of a 1M-context Opus: past the gateway's 65,536 it was refused before the audit.
    expect((await settingsOf("claude-opus-5")).env).toEqual({
      ...slots("claude-opus-5[1m]"),
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    });
    expect((await settingsOf("claude-haiku-4-5")).env).toEqual({
      ...slots("claude-haiku-4-5"),
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    });
  });

  test("OpenCode asks every Anthropic model for no more output than the gateway takes", () => {
    // OpenCode's catalog gives Opus 5, Sonnet 5 and Fable 5 128,000 output; the gateway refused (output_limit_exceeded).
    const gateway = { baseURL: "https://gw/anthropic", apiKey: "cap" };
    const retained = { models: { other: { name: "kept" } }, options: { timeout: 5 } };
    const merged = mergeOpenCodeProviderConfig("anthropic", retained, gateway);
    expect(merged.options).toEqual({ timeout: 5, ...gateway });
    const models = merged.models as Record<string, unknown>;
    expect(models.other).toEqual({ name: "kept" });
    expect(models["claude-opus-5"]).toEqual({ limit: { context: 1_000_000, output: 64_000 } });
    expect(models["claude-haiku-4-5"]).toEqual({ limit: { context: 200_000, output: 64_000 } });
    for (const id of OPENCODE_ALLOWED_MODELS.anthropic) {
      const { limit } = models[id] as { limit: { output: number } };
      expect(limit.output).toBeLessThanOrEqual(65_536);
    }
  });

  test("leaves 200K model ids unchanged", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const context = ctx();
    context.model = "claude-haiku-4-5";

    expect(providerGatewayEnv(context, "claude").ANTHROPIC_MODEL).toBe(
      "claude-haiku-4-5",
    );
  });

  test("OpenCode pre-wires all paid providers for warm model switches", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    const options = opencodeProviderGatewayOptions(ctx());
    expect(options.anthropic?.baseURL).toEndWith("/api/provider/anthropic/v1");
    expect(options.openai?.baseURL).toEndWith("/api/provider/openai/v1");
    expect(options.openrouter?.baseURL).toEndWith("/api/provider/openrouter/v1");
    expect(options.cerebras?.baseURL).toEndWith("/api/provider/cerebras/v1");
    expect(options.opencode?.baseURL).toEndWith("/api/provider/opencode/v1");
    expect(verifyProviderToken(options.anthropic?.apiKey)).toMatchObject({ provider: "anthropic" });
    expect(verifyProviderToken(options.openai?.apiKey)).toMatchObject({ provider: "openai" });
    expect(verifyProviderToken(options.openrouter?.apiKey)).toMatchObject({ provider: "openrouter" });
    expect(verifyProviderToken(options.cerebras?.apiKey)).toMatchObject({ provider: "cerebras" });
    expect(verifyProviderToken(options.opencode?.apiKey)).toMatchObject({ provider: "opencode" });
    expect(SANDBOX_GENERATION).toBe("provider-gateway-v17-useagent-mcp-gateway-only-secrets");
    expect(providerGatewaySandboxLabels("run-a")).toEqual({
      "useagent-run": "run-a",
      "useagent-provider-generation": SANDBOX_GENERATION,
    });
  });

  test.each([
    ["default", undefined, 4 * 60 * 60 * 1000 + 15 * 60 * 1000],
    ["maximum", String(5 * 60 * 60 * 1000), 5 * 60 * 60 * 1000],
    ["custom", "60000", 60_000],
  ] as const)("configured %s provider TTL is the signed-token lifetime ceiling", (_name, rawTtl, ttlMs) => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    if (rawTtl === undefined) delete process.env.PROVIDER_GATEWAY_TOKEN_TTL_MS;
    else process.env.PROVIDER_GATEWAY_TOKEN_TTL_MS = rawTtl;
    const context = ctx();
    context.threadId = `thread-provider-lifetime-${_name}`;
    context.runId = `run-provider-lifetime-${_name}`;

    const before = Date.now();
    const token = opencodeProviderGatewayOptions(context).anthropic?.apiKey;
    const after = Date.now();
    const claims = verifyProviderToken(token, before);

    expect(claims).not.toBeNull();
    expectLifetime(claims!.exp, [before, after], ttlMs);
  });

  test.each([
    ["default", undefined, 6 * 60 * 60 * 1000],
    ["maximum", String(7 * 24 * 60 * 60 * 1000), 7 * 24 * 60 * 60 * 1000],
    ["custom", "60000", 60_000],
  ] as const)("configured %s tool TTL is the signed-token lifetime ceiling", async (_name, rawTtl, ttlMs) => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    if (rawTtl === undefined) delete process.env.TOOL_GATEWAY_TOKEN_TTL_MS;
    else process.env.TOOL_GATEWAY_TOKEN_TTL_MS = rawTtl;
    const context = ctx();
    context.threadId = `thread-tool-lifetime-${_name}`;
    context.runId = `run-tool-lifetime-${_name}`;
    const { sandbox, files } = recordingSandbox();

    const before = Date.now();
    await prepareProviderGatewaySandbox(sandbox, context, "claude");
    const after = Date.now();
    const config = JSON.parse(files["/tmp/useagent-claude-capability/useagent-mcp.json"]!) as {
      mcpServers: Record<string, { headers: { Authorization: string } }>;
    };
    const token = config.mcpServers[TOOL_GATEWAY_SERVER_NAME]!.headers.Authorization.replace(/^Bearer /, "");
    const claims = verifyToolToken(token, before);

    expect(claims).not.toBeNull();
    expectLifetime(claims!.exp, [before, after], ttlMs);
  });

  test("OpenCode thread provider tokens are memoized per user", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-provider-user-key";
    first.runId = "run-provider-a";
    first.userId = "user-a";
    const second = ctx();
    second.threadId = "thread-provider-user-key";
    second.runId = "run-provider-b";
    second.userId = "user-b";

    const firstToken = opencodeProviderGatewayOptions(first).openrouter?.apiKey;
    const secondToken = opencodeProviderGatewayOptions(second).openrouter?.apiKey;

    expect(firstToken).not.toBe(secondToken);
    expect(verifyProviderToken(firstToken)).toMatchObject({
      userId: "user-a",
      issuedRunId: "run-provider-a",
      scope: "thread",
    });
    expect(verifyProviderToken(secondToken)).toMatchObject({
      userId: "user-b",
      issuedRunId: "run-provider-b",
      scope: "thread",
    });
  });

  test("warm turns reuse the same bounded provider token for the same identity", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-provider-warm-reuse";
    first.runId = "run-provider-warm-a";
    const second = ctx();
    second.threadId = first.threadId;
    second.runId = "run-provider-warm-b";

    const firstToken = opencodeProviderGatewayOptions(first).openai?.apiKey;
    const secondToken = opencodeProviderGatewayOptions(second).openai?.apiKey;

    expect(secondToken).toBe(firstToken);
    expect(verifyProviderToken(secondToken)).toMatchObject({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-provider-warm-reuse",
      issuedRunId: "run-provider-warm-a",
      scope: "thread",
    });
  });

  test("OpenCode thread provider tokens are isolated by organization", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-provider-org-key";
    first.runId = "run-provider-org-a";
    first.orgId = "org-a";
    first.userId = "user-shared";
    const second = ctx();
    second.threadId = "thread-provider-org-key";
    second.runId = "run-provider-org-b";
    second.orgId = "org-b";
    second.userId = "user-shared";

    const firstToken = opencodeProviderGatewayOptions(first).openai?.apiKey;
    const secondToken = opencodeProviderGatewayOptions(second).openai?.apiKey;

    expect(firstToken).not.toBe(secondToken);
    expect(verifyProviderToken(firstToken)).toMatchObject({
      orgId: "org-a",
      userId: "user-shared",
      issuedRunId: "run-provider-org-a",
      scope: "thread",
    });
    expect(verifyProviderToken(secondToken)).toMatchObject({
      orgId: "org-b",
      userId: "user-shared",
      issuedRunId: "run-provider-org-b",
      scope: "thread",
    });
  });

  test("Codex MCP tool tokens written to config are memoized per user", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-tool-user-key";
    first.runId = "run-tool-a";
    first.userId = "user-a";
    first.model = "gpt-5.6-sol";
    const second = ctx();
    second.threadId = "thread-tool-user-key";
    second.runId = "run-tool-b";
    second.userId = "user-b";
    second.model = "gpt-5.6-sol";
    const { sandbox, files } = recordingSandbox();

    await prepareProviderGatewaySandbox(sandbox, first, "codex");
    const firstConfig = files["$HOME/.codex/config.toml"]!;
    await prepareProviderGatewaySandbox(sandbox, second, "codex");
    const secondConfig = files["$HOME/.codex/config.toml"]!;

    const firstBearer = firstConfig.match(/Authorization = "Bearer ([^"]+)"/)?.[1];
    const secondBearer = secondConfig.match(/Authorization = "Bearer ([^"]+)"/)?.[1];
    expect(firstBearer).toBeTruthy();
    expect(secondBearer).toBeTruthy();
    expect(firstBearer).not.toBe(secondBearer);
    expect(verifyToolToken(firstBearer)).toMatchObject({
      userId: "user-a",
      runId: "run-tool-a",
      scope: "thread",
    });
    expect(verifyToolToken(secondBearer)).toMatchObject({
      userId: "user-b",
      runId: "run-tool-b",
      scope: "thread",
    });
  });

  test("Codex MCP tool tokens written to config are isolated by organization", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-tool-org-key";
    first.runId = "run-tool-org-a";
    first.orgId = "org-a";
    first.userId = "user-shared";
    first.model = "gpt-5.6-sol";
    const second = ctx();
    second.threadId = "thread-tool-org-key";
    second.runId = "run-tool-org-b";
    second.orgId = "org-b";
    second.userId = "user-shared";
    second.model = "gpt-5.6-sol";
    const { sandbox, files } = recordingSandbox();

    await prepareProviderGatewaySandbox(sandbox, first, "codex");
    const firstConfig = files["$HOME/.codex/config.toml"]!;
    await prepareProviderGatewaySandbox(sandbox, second, "codex");
    const secondConfig = files["$HOME/.codex/config.toml"]!;

    const firstBearer = firstConfig.match(/Authorization = "Bearer ([^"]+)"/)?.[1];
    const secondBearer = secondConfig.match(/Authorization = "Bearer ([^"]+)"/)?.[1];
    expect(firstBearer).toBeTruthy();
    expect(secondBearer).toBeTruthy();
    expect(firstBearer).not.toBe(secondBearer);
    expect(verifyToolToken(firstBearer)).toMatchObject({
      orgId: "org-a",
      userId: "user-shared",
      runId: "run-tool-org-a",
      scope: "thread",
    });
    expect(verifyToolToken(secondBearer)).toMatchObject({
      orgId: "org-b",
      userId: "user-shared",
      runId: "run-tool-org-b",
      scope: "thread",
    });
  });

  test("warm reuse trusts the Daytona generation label, not the sandbox file alone", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    let shellChecks = 0;
    const sandbox = {
      labels: {
        [LEGACY_SANDBOX_RUN_LABEL]: "run-a",
        [LEGACY_SANDBOX_GENERATION_LABEL]: "provider-gateway-v16-gateway-only-secrets",
      },
      process: {
        executeCommand: async () => {
          shellChecks++;
          return { exitCode: 0 };
        },
      },
    } as unknown as SandboxHandle;
    expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(false);
    expect(shellChecks).toBe(0);

    const currentLabels = providerGatewaySandboxLabels("run-a");
    (sandbox as unknown as { labels: Record<string, string> }).labels = currentLabels;
    expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(true);
    expect(shellChecks).toBe(1);

    (sandbox as unknown as { labels: Record<string, string> }).labels = {
      [CANONICAL_SANDBOX_GENERATION_LABEL]: currentLabels[CANONICAL_SANDBOX_GENERATION_LABEL]!,
    };
    expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(true);
    expect(shellChecks).toBe(2);

    (sandbox as unknown as { labels: Record<string, string> }).labels = {
      [CANONICAL_SANDBOX_GENERATION_LABEL]: currentLabels[CANONICAL_SANDBOX_GENERATION_LABEL]!,
      [LEGACY_SANDBOX_GENERATION_LABEL]: "conflicting-generation",
    };
    expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(false);
    expect(shellChecks).toBe(2);
  });

  test("compatibility sandboxes cannot survive a gateway-only transition", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.NODE_ENV = "development";
    process.env.SANDBOX_SECRET_MODE = "compatibility";
    const compatibilityLabels = providerGatewaySandboxLabels("run-compatibility");
    expect(compatibilityLabels[CANONICAL_SANDBOX_GENERATION_LABEL]).toBe(
      "provider-gateway-v17-useagent-mcp-compatibility-secrets",
    );

    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    let shellChecks = 0;
    const retained = {
      labels: compatibilityLabels,
      process: {
        executeCommand: async () => {
          shellChecks++;
          return { exitCode: 0 };
        },
      },
    } as unknown as SandboxHandle;

    expect(await providerGatewaySandboxIsCurrent(retained)).toBe(false);
    expect(shellChecks).toBe(0);
    expect(providerGatewaySandboxLabels("run-gateway")[CANONICAL_SANDBOX_GENERATION_LABEL]).toBe(
      SANDBOX_GENERATION,
    );
  });
});
