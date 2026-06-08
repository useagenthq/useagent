// Regression test for #127: the ACP per-sandbox package install must be idempotent
// on the ACTUAL install path (~/.local/bin/<bin>), NEVER `command -v <bin>`. The base
// Daytona image already ships a `claude` on PATH, so a `command -v`-keyed check would
// see it, SKIP the install, and never create ~/.local/bin/claude - the exact path
// CLAUDE_CODE_EXECUTABLE points the ACP agent at. That produced the live failure
// "Claude Code native binary not found at ~/.local/bin/claude". Lock the invariant so
// a future refactor can't quietly reintroduce a PATH-based check.

import { describe, expect, test } from "bun:test";
import {
  buildAcpInstallClause,
  acpRunningLabel,
  codexModelSelectionRequest,
  buildAcpRuntimeEnvExports,
  claudeAcpConfig,
  codexAcpConfig,
} from "./acp-server";

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
    expect((clause.match(/npm install -g --prefix \$HOME\/\.local/g) ?? []).length).toBe(2);
  });

  test("claude: the provisioned path is EXACTLY where CLAUDE_CODE_EXECUTABLE looks", () => {
    // The heart of #127: whatever CLAUDE_CODE_EXECUTABLE points at must be the same
    // path the install clause guarantees exists.
    const execPath = claudeAcpConfig.agentEnv?.CLAUDE_CODE_EXECUTABLE;
    expect(execPath).toBe("$HOME/.local/bin/claude");
    const claudePkg = claudeAcpConfig.packages.find((p) => p.bin === "claude");
    expect(claudePkg).toBeTruthy();
    const clause = buildAcpInstallClause(claudeAcpConfig.packages);
    // The clause provisions the claude binary at the exec path (modulo the leading $HOME).
    expect(clause).toContain(`[ -x "${execPath}" ]`);
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

  test("uses product engine names without leaking process residency", () => {
    expect(acpRunningLabel("claude")).toBe("Running Claude Code…");
    expect(acpRunningLabel("codex")).toBe("Running Codex…");
    expect(acpRunningLabel("claude")).not.toContain("resident");
  });

  test("runtime env exports refresh gateway endpoints while preserving $HOME expansion", () => {
    const exports = buildAcpRuntimeEnvExports({
      ANTHROPIC_BASE_URL: "https://gateway.example.test/api/provider/anthropic",
      ANTHROPIC_MODEL: "claude-opus-5",
      CLAUDE_CODE_EXECUTABLE: "$HOME/.local/bin/claude",
    });

    expect(exports).toContain(
      "export ANTHROPIC_BASE_URL='https://gateway.example.test/api/provider/anthropic';",
    );
    expect(exports).toContain("export ANTHROPIC_MODEL='claude-opus-5';");
    expect(exports).toContain('export CLAUDE_CODE_EXECUTABLE="$HOME/.local/bin/claude";');
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
