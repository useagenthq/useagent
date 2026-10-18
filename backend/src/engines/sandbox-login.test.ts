// A login lent by the user's own machine: only a local binding can lend one,
// the sandbox must actually carry it, and the engine is pointed at the tool
// gateway alone once it is installed.

import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import type { EngineRunContext } from "./types";
import {
  claudeLoginEnvironment,
  codexLoginConfigToml,
  dispatchReadyForUser,
  installSandboxLogin,
  loginLent,
  sandboxLogin,
  sandboxLoginOffered,
} from "./sandbox-login";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

function fakeSandbox(answers: (command: string) => { exitCode: number; result?: string } = () => ({ exitCode: 0 })) {
  const commands: string[] = [];
  const sandbox = {
    process: {
      async executeCommand(command: string) {
        commands.push(command);
        const answer = answers(command);
        return { exitCode: answer.exitCode, result: answer.result ?? "", stdout: answer.result ?? "", stderr: "" };
      },
    },
  } as unknown as SandboxHandle;
  return { sandbox, commands };
}

function ctx(model?: string): EngineRunContext & { steps: string[] } {
  const steps: string[] = [];
  return {
    runId: "run-1",
    orgId: "org-a",
    userId: "user-1",
    threadId: "thread-1",
    model,
    async emit(step: { label: string }) {
      steps.push(step.label);
      return undefined;
    },
    steps,
  } as unknown as EngineRunContext & { steps: string[] };
}

describe("sandbox login", () => {
  test("only a local binding lends a login, and only for the engines that have one", () => {
    for (const kind of ["daytona", "cube", "box"] as const) {
      expect(loginLent({ kind, logins: ["codex", "claude"] }, "codex")).toBe(false);
    }
    expect(loginLent({ kind: "local", logins: [] }, "codex")).toBe(false);
    expect(loginLent({ kind: "local", logins: ["codex"] }, "claude")).toBe(false);
    expect(loginLent({ kind: "local", logins: ["codex"] }, "codex")).toBe(true);
    expect(loginLent({ kind: "local", logins: ["opencode"] }, "opencode")).toBe(false);
  });

  test("the login is used only when the runner mounted it, and its path must be plain", async () => {
    const mounted = fakeSandbox((command) => (command.includes("USEAGENT_LOGIN_CODEX") ? { exitCode: 0, result: "/run/useagent/logins/codex/auth.json\n" } : { exitCode: 1 }));
    expect(await sandboxLogin(mounted.sandbox, { kind: "local", logins: ["codex"] }, "codex")).toEqual({ engine: "codex", path: "/run/useagent/logins/codex/auth.json" });
    expect(await sandboxLogin(mounted.sandbox, { kind: "local", logins: ["codex"] }, "claude")).toBeNull();
    // A hosted binding never asks the sandbox at all.
    const hosted = fakeSandbox();
    expect(await sandboxLogin(hosted.sandbox, { kind: "cube", logins: ["codex"] }, "codex")).toBeNull();
    expect(hosted.commands).toEqual([]);
    const missing = fakeSandbox(() => ({ exitCode: 1 }));
    expect(await sandboxLogin(missing.sandbox, { kind: "local", logins: ["codex"] }, "codex")).toBeNull();
    const odd = fakeSandbox(() => ({ exitCode: 0, result: "/tmp/x; rm -rf /" }));
    expect(await sandboxLogin(odd.sandbox, { kind: "local", logins: ["codex"] }, "codex")).toBeNull();
  });

  test("a run its thread placed on the machine is offered the login by the same rule the binding applies", async () => {
    const online = { logins: ["codex", "claude"] as readonly string[] };
    const deps = (runner: typeof online | null, policy: { allowLocalExecution: boolean; allowLocalLogins: boolean }, env: Record<string, string> = {}) => ({
      env,
      seam: () => ({ onlineForUser: () => runner as never }),
      policy: async () => policy,
    });
    const allowed = { allowLocalExecution: true, allowLocalLogins: true };
    const local = { orgId: "org", userId: "user", runLocation: "local" as const };
    expect(await sandboxLoginOffered(local, "codex", deps(online, allowed))).toBe(true);
    expect(await sandboxLoginOffered(local, "opencode", deps(online, allowed))).toBe(false);
    expect(await sandboxLoginOffered(local, "codex", deps(null, allowed))).toBe(false);
    expect(await sandboxLoginOffered(local, "codex", deps({ logins: ["claude"] }, allowed))).toBe(false);
    expect(await sandboxLoginOffered(local, "codex", deps(online, { ...allowed, allowLocalLogins: false }))).toBe(false);
    expect(await sandboxLoginOffered(local, "codex", deps(online, { ...allowed, allowLocalExecution: false }))).toBe(false);
    expect(await sandboxLoginOffered(local, "codex", deps(online, allowed, { LOCAL_RUNNERS: "off" }))).toBe(false);
    expect(await sandboxLoginOffered({ ...local, userId: null }, "codex", deps(online, allowed))).toBe(false);
    // A thread on the cloud, or one that made no choice, never sees the machine's login however connected it is.
    expect(await sandboxLoginOffered({ orgId: "org", userId: "user", runLocation: "cloud" }, "codex", deps(online, allowed))).toBe(false);
    expect(await sandboxLoginOffered({ orgId: "org", userId: "user", runLocation: null }, "codex", deps(online, allowed))).toBe(false);
    expect(await sandboxLoginOffered({ orgId: "org", userId: "user" }, "codex", deps(online, allowed))).toBe(false);
  });

  test("a plane that cannot reach the vendor still dispatches when the user's machine offers the login", async () => {
    // Nothing here says the plane's Anthropic provider is healthy, so the plane alone is not ready.
    const env = { ENABLED_ENGINES: "claude,codex", NODE_ENV: "production" };
    const online = { logins: ["claude"] as readonly string[] };
    const deps = (runner: typeof online | null) => ({ env, seam: () => ({ onlineForUser: () => runner as never }), policy: async () => ({ allowLocalExecution: true, allowLocalLogins: true }) });
    const scope = { orgId: "org", userId: "user", runLocation: "local" as const };
    expect(await dispatchReadyForUser(scope, "claude", "claude-opus-5", "accepted", deps(null))).toBe(false);
    expect(await dispatchReadyForUser(scope, "claude", "claude-opus-5", "accepted", deps(online))).toBe(true);
    // The same run placed on the cloud cannot use the machine's login, so it is not ready.
    expect(await dispatchReadyForUser({ ...scope, runLocation: "cloud" }, "claude", "claude-opus-5", "accepted", deps(online))).toBe(false);
    expect(await dispatchReadyForUser(scope, "claude", "claude-opus-5", "persisted", deps(online))).toBe(true);
    // The login never widens what the engine or model policy allows.
    expect(await dispatchReadyForUser(scope, "codex", "gpt-5.6-luna", "accepted", deps(online))).toBe(false);
    expect(await dispatchReadyForUser(scope, "claude", "not-a-model", "accepted", deps(online))).toBe(false);
    expect(await dispatchReadyForUser(scope, "opencode", "openai/gpt-5.6-luna", "accepted", deps(online))).toBe(false);
  });

  test("Codex on its login names no model provider and keeps the tool gateway", () => {
    const config = codexLoginConfigToml("gpt-5.6-luna", { url: "https://plane.example/tools", bearerToken: "t" });
    expect(config).toContain('model = "gpt-5.6-luna"');
    expect(config).not.toContain("model_provider");
    expect(config).not.toContain("model_providers");
    expect(config).toContain("[mcp_servers.");
    expect(config).toContain("https://plane.example/tools");
    expect(codexLoginConfigToml("gpt-5.6-luna")).not.toContain("mcp_servers");
    expect(claudeLoginEnvironment()).toEqual({ CLAUDE_CONFIG_DIR: `/tmp/${SANDBOX_NAME_PREFIX}-claude-config` });
  });

  test("installing the Codex login copies it into place and writes only the login config", async () => {
    const { sandbox, commands } = fakeSandbox();
    const context = ctx("gpt-5.6-luna");
    await installSandboxLogin(sandbox, context, { engine: "codex", path: "/run/useagent/logins/codex/auth.json" }, { runsAsRoot: false });
    const joined = commands.join("\n");
    expect(joined).toContain("$HOME/.codex/config.toml");
    expect(joined).toContain(`cp -- '/run/useagent/logins/codex/auth.json' "$HOME/.codex/auth.json"`);
    expect(joined).not.toContain("rm -f $HOME/.codex/auth.json");
    expect(joined).not.toContain("provider-openai.token");
    expect(context.steps).toEqual(["Using the Codex login from your machine"]);
    await expect(installSandboxLogin(sandbox, context, { engine: "codex", path: "/tmp/x;id" }, { runsAsRoot: false })).rejects.toThrow(/plain path/);
  });

  test("installing the Claude login leaves the settings without a key helper and puts the credentials in the managed config dir", async () => {
    const { sandbox, commands } = fakeSandbox();
    await installSandboxLogin(sandbox, ctx(), { engine: "claude", path: "/run/useagent/logins/claude/.credentials.json" }, { runsAsRoot: false });
    const joined = commands.join("\n");
    expect(joined).toContain(`/tmp/${SANDBOX_NAME_PREFIX}-claude-config/.credentials.json`);
    expect(joined).not.toContain("apiKeyHelper");
    expect(joined).not.toContain("provider-anthropic");
    const root = fakeSandbox();
    await installSandboxLogin(root.sandbox, ctx(), { engine: "claude", path: "/run/useagent/logins/claude/.credentials.json" }, { runsAsRoot: true });
    expect(root.commands.join("\n")).toContain(`install -d -o 1000 -g 1000 -m 700 '/tmp/${SANDBOX_NAME_PREFIX}-claude-config'`);
  });
});
