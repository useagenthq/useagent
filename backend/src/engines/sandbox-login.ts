// An engine login from the user's own machine, used inside a sandbox on that
// machine in place of the plane's provider gateway capability. The runner
// mounts the login and names it in USEAGENT_LOGIN_<ENGINE>; the binding says
// whether the org lent it. Only a run whose thread asked to run on the machine
// (run_location "local") carries any login, so every hosted provider takes the
// provider gateway path untouched. Tools still reach the plane through the tool
// gateway; only the model call goes straight from the sandbox to the vendor
// with the user's own login.

import type { RunLocation } from "@useagent/agent-client/wire";
import { activeRunnerSeam } from "../runners/directory";
import { getRunnerPolicy, localRunnersEnabled } from "../runners/policy";
import type { EngineId } from "../db/schema";
import { isModelAllowedForEngine, isPersistedModelAllowedForEngine } from "../runs/model-policy";
import {
  type EngineResolution,
  engineEnabledForDispatch,
  engineModelReadyForDispatch,
  persistedEngineModelReadyForDispatch,
  resolveAcceptedEngine,
} from "../runs/engine-readiness";
import type { SandboxBinding } from "../sandboxes/binding";
import type { SandboxHandle } from "../sandboxes/provider";
import type { SandboxRuntimeLayout } from "../sandboxes/provider";
import { TOOL_GATEWAY_SERVER_NAME, toCodexToolGatewayConfig } from "../knowledge/gateway/descriptor";
import {
  CLAUDE_ACP_SETTINGS_FILE,
  CLAUDE_CONFIG_DIR,
  CLAUDE_MCP_CONFIG_FILE,
  CLAUDE_SETTINGS_FILE,
  claudeMcpConfig,
  codexToolGatewayDescriptor,
  markProviderGatewaySandboxCurrent,
  toolGatewayDescriptor,
  writeClaudeCapabilityFiles,
  writePrivateFiles,
  writeUserClaudeCapabilityFiles,
} from "../provider-gateway/sandbox-config";
import type { EngineRunContext } from "./types";

export type ModelCredentialSource = "plane" | "sandbox-login";
export type LoginEngine = "codex" | "claude";

const LOGIN_ENGINES: ReadonlySet<string> = new Set<LoginEngine>(["codex", "claude"]);
const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
const LOGIN_PATH = /^\/[A-Za-z0-9._/-]+$/;

export function isLoginEngine(engine: string): engine is LoginEngine {
  return LOGIN_ENGINES.has(engine);
}

/** The variable the runner sets to the mounted login's path. */
export function sandboxLoginVariable(engine: LoginEngine): string {
  return `USEAGENT_LOGIN_${engine.toUpperCase()}`;
}

/** Whether the binding lends this engine's login. A hosted binding never does. */
export function loginLent(binding: Pick<SandboxBinding, "kind" | "logins">, engine: string): boolean {
  return binding.kind === "local" && isLoginEngine(engine) && binding.logins.includes(engine);
}

export interface SandboxLogin {
  readonly engine: LoginEngine;
  /** The mounted file inside the sandbox. */
  readonly path: string;
}

/** The login inside the sandbox, when the binding lends it and the runner mounted it. */
export async function sandboxLogin(
  sandbox: Pick<SandboxHandle, "process">,
  binding: Pick<SandboxBinding, "kind" | "logins">,
  engine: string,
): Promise<SandboxLogin | null> {
  if (!isLoginEngine(engine) || !loginLent(binding, engine)) return null;
  const variable = sandboxLoginVariable(engine);
  const result = await sandbox.process.executeCommand(`test -r "$${variable}" && printf %s "$${variable}"`, undefined, undefined, 10);
  const path = (result.exitCode ?? 1) === 0 ? (result.result ?? "").trim() : "";
  return LOGIN_PATH.test(path) ? { engine, path } : null;
}

export interface LoginOfferDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly seam?: () => Pick<ReturnType<typeof activeRunnerSeam>, "onlineForUser">;
  readonly policy?: typeof getRunnerPolicy;
}

/** The user and the place the thread runs, as every readiness question sees them. */
export interface LoginScope {
  readonly orgId: string | null | undefined;
  readonly userId: string | null | undefined;
  /** The thread's run_location; a login is offered only to a thread bound to the machine. */
  readonly runLocation?: RunLocation | null;
}

/** Whether a run for this user would carry the engine's login: the rule the binding applies, asked before the run exists. */
export async function sandboxLoginOffered(scope: LoginScope, engine: string, deps: LoginOfferDeps = {}): Promise<boolean> {
  if (scope.runLocation !== "local") return false;
  if (!isLoginEngine(engine) || !scope.orgId || !scope.userId || !localRunnersEnabled(deps.env ?? process.env)) return false;
  const runner = (deps.seam ?? activeRunnerSeam)().onlineForUser(scope.orgId, scope.userId);
  if (!runner || !runner.logins.includes(engine)) return false;
  const policy = await (deps.policy ?? getRunnerPolicy)(scope.orgId);
  return policy.allowLocalExecution && policy.allowLocalLogins;
}

/** Engine resolution at run creation, with the user's machine login able to stand in for the plane's provider. */
export async function resolveEngineForUser(
  scope: LoginScope,
  rawEngine: unknown,
  deps: LoginOfferDeps = {},
): Promise<EngineResolution> {
  const resolved = resolveAcceptedEngine(rawEngine, deps.env ?? process.env);
  if (resolved.ok || resolved.reason !== "provider_unhealthy" || !resolved.engine) return resolved;
  return (await sandboxLoginOffered(scope, resolved.engine, deps)) ? { ok: true, engine: resolved.engine } : resolved;
}

/**
 * Dispatch readiness a machine login may satisfy: the engine enabled and the
 * model allowed exactly as before, and either the plane's provider is healthy
 * or the user's machine offers the engine's login. Acceptance and the worker
 * ask this one question.
 */
export async function dispatchReadyForUser(
  scope: LoginScope,
  engine: EngineId,
  model: string,
  policy: "accepted" | "persisted",
  deps: LoginOfferDeps = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const ready = policy === "persisted" ? persistedEngineModelReadyForDispatch(engine, model, env) : engineModelReadyForDispatch(engine, model, env);
  if (ready) return true;
  const allowed = policy === "persisted" ? isPersistedModelAllowedForEngine(engine, model, env) : isModelAllowedForEngine(engine, model, env);
  return engineEnabledForDispatch(engine, env) && allowed && (await sandboxLoginOffered(scope, engine, deps));
}

/** Claude's process configuration on a login: the managed config dir, no gateway address. */
export function claudeLoginEnvironment(): Record<string, string> {
  return { CLAUDE_CONFIG_DIR };
}

/** Codex on its own login: the default provider with the mounted auth, the tool gateway as its only server. */
export function codexLoginConfigToml(model: string, toolGateway?: { readonly url: string; readonly bearerToken: string }): string {
  return [
    `model = ${JSON.stringify(model)}`,
    // The agent already runs inside its container; Codex's inner sandbox is redundant there.
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    // Native goals let Codex start turns on its own, outside admission and spend checks.
    "features.goals = false",
    "",
    ...(toolGateway
      ? [
          `[mcp_servers.${TOOL_GATEWAY_SERVER_NAME}]`,
          `url = ${JSON.stringify(toolGateway.url)}`,
          `http_headers = { Authorization = ${JSON.stringify(`Bearer ${toolGateway.bearerToken}`)} }`,
          "enabled = true",
          "required = true",
          'default_tools_approval_mode = "auto"',
          "",
        ]
      : []),
  ].join("\n");
}

async function run(sandbox: Pick<SandboxHandle, "process">, command: string, what: string): Promise<void> {
  const result = await sandbox.process.executeCommand(command, undefined, undefined, 20);
  if ((result.exitCode ?? 1) !== 0) throw new Error(`failed to ${what}`);
}

/** Put the mounted login where the engine reads it and point the engine at the tool gateway only. */
export async function installSandboxLogin(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  { engine, path: login }: SandboxLogin,
  layout: Pick<SandboxRuntimeLayout, "runsAsRoot">,
): Promise<void> {
  if (!LOGIN_PATH.test(login)) throw new Error("the login path is not a plain path");
  if (engine === "codex") {
    const descriptor = codexToolGatewayDescriptor(ctx);
    await writePrivateFiles(sandbox, [
      { path: "$HOME/.codex/config.toml", content: codexLoginConfigToml(ctx.model?.trim() || DEFAULT_CODEX_MODEL, descriptor ? toCodexToolGatewayConfig(descriptor) : undefined) },
    ]);
    await run(sandbox, `install -d -m 700 "$HOME/.codex" && cp -- '${login}' "$HOME/.codex/auth.json" && chmod 600 "$HOME/.codex/auth.json"`, "install the Codex login");
  } else {
    const files = [
      { path: CLAUDE_ACP_SETTINGS_FILE, content: "{}" },
      { path: CLAUDE_SETTINGS_FILE, content: "{}" },
      { path: CLAUDE_MCP_CONFIG_FILE, content: claudeMcpConfig(toolGatewayDescriptor(ctx, "claude")) },
    ];
    await (layout.runsAsRoot ? writeClaudeCapabilityFiles(sandbox, files) : writeUserClaudeCapabilityFiles(sandbox, files));
    const owner = layout.runsAsRoot ? " -o 1000 -g 1000" : "";
    await run(
      sandbox,
      `install -d${owner} -m 700 '${CLAUDE_CONFIG_DIR}' && install${owner} -m 600 -- '${login}' '${CLAUDE_CONFIG_DIR}/.credentials.json'`,
      "install the Claude login",
    );
  }
  await markProviderGatewaySandboxCurrent(sandbox);
  await ctx.emit({ kind: "task", label: `Using the ${engine === "codex" ? "Codex" : "Claude"} login from your machine`, chip: `runtime:${engine}` });
}
