// Regression test for #127: the ACP per-sandbox package install must be idempotent
// on the ACTUAL install path (~/.local/bin/<bin>), NEVER `command -v <bin>`. The base
// Daytona image already ships a `claude` on PATH, so a `command -v`-keyed check would
// see it, SKIP the install, and never create ~/.local/bin/claude - the exact path
// CLAUDE_CODE_EXECUTABLE points the ACP agent at. That produced the live failure
// "Claude Code native binary not found at ~/.local/bin/claude". Lock the invariant so
// a future refactor can't quietly reintroduce a PATH-based check.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAcpInstallClause,
  acpRunningLabel,
  codexModelSelectionRequest,
  buildAcpRuntimeEnvExports,
  claudeAcpConfig,
  codexAcpConfig,
} from "./acp-server";
import { CODEX_ACP_FULL_ACCESS_MODE, codexAgentModeRequest } from "./acp-provisioning";

const tempHomes: string[] = [];

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { force: true, recursive: true });
});

function fakeNpmHome(mode: "recover" | "fail" | "concurrent"): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "useagent-acp-provisioning-"));
  tempHomes.push(home);
  const binDir = join(home, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const npm = join(binDir, "npm");
  writeFileSync(
    npm,
    `#!/bin/sh
count_file="$HOME/npm-count-$EXPECTED_BIN"
count=0
[ ! -f "$count_file" ] || count=$(cat "$count_file")
count=$((count + 1))
printf '%s' "$count" > "$count_file"
printf '%s\\n' "$*" >> "$HOME/npm-calls"
echo "registry output with secret-token-that-must-not-leak" >&2
if [ "${mode}" = "concurrent" ] && [ "$count" -eq 1 ]; then
  touch "$HOME/first-$EXPECTED_BIN"
  i=0
  while { [ ! -e "$HOME/first-useagent-acp-a" ] || [ ! -e "$HOME/first-useagent-acp-b" ]; } && [ "$i" -lt 500 ]; do
    i=$((i + 1))
    sleep 0.01
  done
  exit 42
fi
if { [ "${mode}" = "recover" ] || [ "${mode}" = "concurrent" ]; } && [ "$count" -eq 2 ] &&
   [ -n "$npm_config_cache" ] && [ -d "$npm_config_cache" ]; then
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/$EXPECTED_BIN"
  chmod +x "$HOME/.local/bin/$EXPECTED_BIN"
  exit 0
fi
exit 42
`,
  );
  chmodSync(npm, 0o755);
  return { home, path: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}` };
}

function runInstallClause(
  packages: { pkg: string; bin: string }[],
  mode: "recover" | "fail",
): { home: string; result: ReturnType<typeof Bun.spawnSync> } {
  const { home, path } = fakeNpmHome(mode);
  const result = Bun.spawnSync({
    cmd: [
      "sh",
      "-c",
      `${buildAcpInstallClause(packages)}printf RELAY > "$HOME/relay-staged"`,
    ],
    env: {
      ...process.env,
      EXPECTED_BIN: packages[0]?.bin ?? "",
      HOME: home,
      PATH: path,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return { home, result };
}

describe("ACP executable provisioning (#127)", () => {
  test("idempotency is keyed on the actual install path, not `command -v`", () => {
    const clause = buildAcpInstallClause([{ pkg: "@scope/pkg@1.2.3", bin: "mybin" }]);
    expect(clause).toContain('[ -x "$HOME/.local/bin/mybin" ]');
    // The regression signature: a PATH lookup would let a base-image binary skip install.
    expect(clause).not.toContain("command -v");
    expect(clause).not.toContain("which mybin");
  });

  test("installs to the ~/.local user prefix (so the path check can find it)", () => {
    const clause = buildAcpInstallClause([{ pkg: "@scope/pkg@1.2.3", bin: "mybin" }]);
    expect(clause).toContain('/usr/local/share/skynet-provider-bin/mybin');
    expect(clause).toContain('ln -sfn "/usr/local/share/skynet-provider-bin/mybin"');
    expect(clause).toContain("npm install -g --prefix $HOME/.local");
    expect(clause).toContain('"@scope/pkg@1.2.3"');
    // check-then-seed/install ordering: skip all work only when the exact user path exists.
    expect(clause).toMatch(/\[ -x "\$HOME\/\.local\/bin\/mybin" \] \|\| \{/);
  });

  test("one clause per package, each independently path-guarded", () => {
    const clause = buildAcpInstallClause([
      { pkg: "a@1", bin: "abin" },
      { pkg: "b@2", bin: "bbin" },
    ]);
    expect(clause).toContain('[ -x "$HOME/.local/bin/abin" ]');
    expect(clause).toContain('[ -x "$HOME/.local/bin/bbin" ]');
    expect((clause.match(/\/usr\/local\/share\/skynet-provider-bin/g) ?? []).length).toBe(4);
    expect((clause.match(/npm install -g --prefix \$HOME\/\.local/g) ?? []).length).toBe(4);
  });

  test("a corrupt npm cache retries privately and verifies the exact executable", () => {
    const bin = "useagent-acp-recovery-test";
    const { home, path } = fakeNpmHome("recover");
    mkdirSync(join(home, ".npm", "_cacache"), { recursive: true });
    const recovered = Bun.spawnSync({
      cmd: [
        "sh",
        "-c",
        `${buildAcpInstallClause([{ pkg: "recovery-package@1", bin }])}printf RELAY > "$HOME/relay-staged"`,
      ],
      env: {
        ...process.env,
        EXPECTED_BIN: bin,
        HOME: home,
        PATH: path,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(recovered.exitCode).toBe(0);
    expect(readFileSync(join(home, `npm-count-${bin}`), "utf8")).toBe("2");
    expect(existsSync(join(home, ".npm", "_cacache"))).toBe(true);
    expect(existsSync(join(home, ".local", "bin", bin))).toBe(true);
    expect(existsSync(join(home, "relay-staged"))).toBe(true);
  });

  test("concurrent recovery uses isolated retry caches", async () => {
    const { home, path } = fakeNpmHome("concurrent");
    mkdirSync(join(home, ".npm", "_cacache"), { recursive: true });
    const run = (bin: string) => Bun.spawn({
      cmd: ["sh", "-c", buildAcpInstallClause([{ pkg: `${bin}@1`, bin }])],
      env: { ...process.env, EXPECTED_BIN: bin, HOME: home, PATH: path },
      stderr: "pipe",
      stdout: "pipe",
    });
    const first = run("useagent-acp-a");
    const second = run("useagent-acp-b");

    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    expect(existsSync(join(home, ".local", "bin", "useagent-acp-a"))).toBe(true);
    expect(existsSync(join(home, ".local", "bin", "useagent-acp-b"))).toBe(true);
  });

  test("a permanent install failure stops later packages and relay staging", () => {
    const { home, result } = runInstallClause(
      [
        { pkg: "first-package@1", bin: "first-acp-bin" },
        { pkg: "later-package@1", bin: "later-acp-bin" },
      ],
      "fail",
    );
    const calls = readFileSync(join(home, "npm-calls"), "utf8");
    const stderr = Buffer.from(result.stderr ?? []).toString();

    expect(result.exitCode).not.toBe(0);
    expect((calls.match(/first-package@1/g) ?? []).length).toBe(2);
    expect(calls).not.toContain("later-package@1");
    expect(existsSync(join(home, "relay-staged"))).toBe(false);
    expect(stderr).toContain(
      "ACP provisioning failed for first-acp-bin: executable missing after cache retry",
    );
    expect(stderr).not.toContain("secret-token-that-must-not-leak");
  });

  test("claude: the provisioned path is EXACTLY where CLAUDE_CODE_EXECUTABLE looks", () => {
    const execPath = claudeAcpConfig.agentEnv?.CLAUDE_CODE_EXECUTABLE;
    expect(execPath).toBe("$HOME/.local/bin/useagent-claude");
    const claudePkg = claudeAcpConfig.packages.find((p) => p.bin === "claude");
    expect(claudePkg).toBeTruthy();
    const clause = buildAcpInstallClause(claudeAcpConfig.packages);
    expect(clause).toContain('[ -x "$HOME/.local/bin/claude" ]');
    expect(claudeAcpConfig.preRelay).toContain(execPath);
    const wrapper = Buffer.from(
      /printf %s '([^']+)'/.exec(claudeAcpConfig.preRelay ?? "")?.[1] ?? "",
      "base64",
    ).toString("utf8");
    expect(wrapper).toContain('--settings "/tmp/useagent-claude-capability/useagent-settings.json"');
    expect(wrapper).toContain('--mcp-config "/tmp/useagent-claude-capability/useagent-mcp.json"');
  });

  test("codex: single package, path-keyed, no PATH-based skip", () => {
    const clause = buildAcpInstallClause(codexAcpConfig.packages);
    expect(clause).toContain('[ -x "$HOME/.local/bin/codex-acp" ]');
    expect(clause).not.toContain("command -v");
  });

  test("codex: applies the selected model through the resident ACP session", () => {
    expect(codexModelSelectionRequest("codex", "session-1", "gpt-5.6-terra")).toEqual({
      method: "session/set_config_option",
      params: {
        configId: "model",
        sessionId: "session-1",
        value: "gpt-5.6-terra",
      },
    });
    expect(codexModelSelectionRequest("claude", "session-1", "claude-opus-5")).toBeNull();
  });

  test("codex: every session is put into full-access mode before it prompts", () => {
    // codex-acp sends its session mode on each turn/start and defaults to
    // workspace-write + on-request, which ignores config.toml and stalls every
    // command inside Daytona behind an escalation approval (audit F6).
    expect(CODEX_ACP_FULL_ACCESS_MODE).toBe("agent-full-access");
    expect(codexAgentModeRequest("codex", "session-1")).toEqual({
      method: "session/set_mode",
      params: { sessionId: "session-1", modeId: "agent-full-access" },
    });
    expect(codexAgentModeRequest("claude", "session-1")).toBeNull();
  });

  test("codex: writes the agent log where a stalled turn reads it back", () => {
    expect(codexAcpConfig.agentEnv?.APP_SERVER_LOGS).toBe("$HOME/.codex/acp-logs");
    expect(codexAcpConfig.agentLogFile).toBe("$HOME/.codex/acp-logs/app-server.log");
    expect(buildAcpRuntimeEnvExports(codexAcpConfig.agentEnv ?? {})).toBe(
      'export APP_SERVER_LOGS="$HOME/.codex/acp-logs"; ',
    );
  });

  test("uses product engine names without leaking process residency", () => {
    expect(acpRunningLabel("claude")).toBe("Running Claude Code…");
    expect(acpRunningLabel("codex")).toBe("Running Codex…");
    expect(acpRunningLabel("claude")).not.toContain("resident");
  });

  test("runtime env exports refresh gateway endpoints while preserving $HOME expansion", () => {
    const exports = buildAcpRuntimeEnvExports({
      ANTHROPIC_BASE_URL: "https://gateway.example.test/api/provider/anthropic",
      ANTHROPIC_MODEL: "claude-opus-5",
      CLAUDE_CONFIG_DIR: "/tmp/skynet-claude-config",
      ...claudeAcpConfig.agentEnv,
    });

    expect(exports).toContain(
      "export ANTHROPIC_BASE_URL='https://gateway.example.test/api/provider/anthropic';",
    );
    expect(exports).toContain("export ANTHROPIC_MODEL='claude-opus-5';");
    expect(exports).toContain('export CLAUDE_CODE_EXECUTABLE="$HOME/.local/bin/useagent-claude";');
    expect(exports).toContain("export CLAUDE_CONFIG_DIR='/tmp/skynet-claude-config';");
  });

  test("runtime env exports reject invalid names and quote opaque values", () => {
    expect(() => buildAcpRuntimeEnvExports({ "BAD-NAME": "value" })).toThrow(
      "invalid ACP runtime environment name",
    );
    expect(buildAcpRuntimeEnvExports({ SAFE_VALUE: "a'b" })).toContain(
      "export SAFE_VALUE='a'\\''b';",
    );
  });
});
