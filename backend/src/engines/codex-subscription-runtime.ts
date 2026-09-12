import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { sandboxPlugin } from "../sandboxes/plugins";
import {
  previewLinkBase,
  sandboxProviderKind,
} from "../sandboxes/provider";
import { openCodexExecServerBridge } from "../provider-connections/codex-exec-server-bridge";
import {
  issueCodexSubscriptionRelayCapability,
  type CodexSubscriptionRelayBinding,
} from "../provider-connections/codex-subscription-relay";
import type { CodexSubscriptionRuntimeSelection } from "../provider-connections/service";
import { DEFAULT_CODEX_MODEL } from "../runs/model-policy";
import {
  codexToolGatewayDescriptor,
  markProviderGatewaySandboxCurrent,
} from "../provider-gateway/sandbox-config";
import type { EngineRunContext } from "./types";
import {
  RUNTIME_ENVIRONMENT_HOME,
  RUNTIME_ENVIRONMENT_WORKDIR,
  RUNTIME_GENERATION,
  RUNTIME_SANDBOX_HOME,
} from "./runtime-environment";

const CODEX_EXEC_SERVER_PORT = 37_734;
const CODEX_EXEC_SERVER_SESSION = "skynet-codex-exec-server";
const RUNTIME_SETTINGS_PATH = `${RUNTIME_ENVIRONMENT_HOME}/userdata/settings.json`;
/** Display name carried only by the subscription (relay-backed) codex instance.
 * T3's legacy `providers.codex` synthesis uses the driver default ("Codex"), so
 * this string appearing in the provider status cache is a reliable content marker
 * that the settings-watch reconcile published the remote instance. */
export const CODEX_SUBSCRIPTION_DISPLAY_NAME = "Codex subscription";
const CODEX_STATUS_CACHE_PATH = `${RUNTIME_ENVIRONMENT_HOME}/caches/codex.json`;
const CODEX_READY_POLL_MS = 150;
const ROOT_RUNTIME_LAYOUT: SandboxRuntimeLayout = {
  home: RUNTIME_SANDBOX_HOME,
  workdir: RUNTIME_ENVIRONMENT_WORKDIR,
  runsAsRoot: true,
};

function codexRuntimeLayout(sandbox: Pick<SandboxHandle, "providerKind">): SandboxRuntimeLayout {
  if (!sandbox.providerKind) return ROOT_RUNTIME_LAYOUT;
  const plugin = sandboxPlugin(sandbox.providerKind);
  return { ...plugin.runtime, runsAsRoot: plugin.runsAsRoot };
}

function codexExecutable(layout: SandboxRuntimeLayout): string {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  return `${prefix}/bin/codex`;
}

export interface CodexSubscriptionLease {
  readonly authEpoch: string | null;
  close(): Promise<void>;
}

interface SubscriptionDependencies {
  readonly openExecBridge: typeof openCodexExecServerBridge;
  readonly issueRelay: typeof issueCodexSubscriptionRelayCapability;
}

const defaultDependencies: SubscriptionDependencies = {
  openExecBridge: openCodexExecServerBridge,
  issueRelay: issueCodexSubscriptionRelayCapability,
};

export async function prepareCodexSubscription(input: {
  readonly sandbox: SandboxHandle;
  readonly ctx: EngineRunContext;
  readonly workdir: string;
  readonly runtime: CodexSubscriptionRuntimeSelection;
  readonly dependencies?: SubscriptionDependencies;
}): Promise<CodexSubscriptionLease> {
  const { sandbox, ctx, workdir, runtime } = input;
  const dependencies = input.dependencies ?? defaultDependencies;
  const orgId = requiredIdentity(ctx.orgId, "organization");
  const userId = requiredIdentity(ctx.userId, "user");
  const environmentId = codexExecutionEnvironmentId(ctx.runId, sandbox.id);
  const layout = codexRuntimeLayout(sandbox);
  let execBridge: ReturnType<typeof openCodexExecServerBridge> | undefined;
  let relay: ReturnType<typeof issueCodexSubscriptionRelayCapability> | undefined;

  await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
  try {
    await sandbox.process.createSession(CODEX_EXEC_SERVER_SESSION);
    const launch = await sandbox.process.executeSessionCommand(
      CODEX_EXEC_SERVER_SESSION,
      {
        command: buildCodexExecServerCommand(environmentId, layout),
        runAsync: true,
        suppressInputEcho: true,
      },
      30,
    );
    if ((launch.exitCode ?? 0) !== 0) {
      throw new Error("Codex exec-server failed to start");
    }

    const readiness = await sandbox.process.executeCommand(
      buildCodexExecServerReadinessCommand(),
      undefined,
      undefined,
      20,
    );
    if ((readiness.exitCode ?? 1) !== 0) {
      throw new Error("Codex exec-server failed readiness");
    }

    const preview = await sandbox.getPreviewLink(CODEX_EXEC_SERVER_PORT);
    const sandboxKind = sandbox.providerKind ?? sandboxProviderKind();
    const upstreamUrl = previewWebSocketUrl(preview.url, sandboxKind);
    execBridge = dependencies.openExecBridge({
      upstreamUrl,
      expectedUpstreamHost: new URL(upstreamUrl).host,
      headers: { ...previewLinkBase(preview).headers },
    });
    const binding: CodexSubscriptionRelayBinding = {
      orgId,
      userId,
      threadId: ctx.threadId ?? ctx.runId,
      runId: ctx.runId,
      connectionId: runtime.connectionId,
      authEpoch: runtime.authEpoch,
      model: ctx.model?.trim() || DEFAULT_CODEX_MODEL,
      sandboxId: sandbox.id,
      sandboxGeneration: RUNTIME_GENERATION,
      environmentId,
      cwd: workdir,
    };
    relay = dependencies.issueRelay({
      binding,
      runtime,
      execServerUrl: execBridge.url,
      toolGateway: codexToolGatewayDescriptor(ctx),
    });
    await patchCodexProviderInstance(sandbox, {
      relayUrl: relay.url,
      environmentId,
      workdir,
    }, layout);
    // Retained-sandbox validation requires both the immutable control-plane
    // generation label and this on-disk marker. Subscription-backed Codex does
    // not materialize the provider-gateway model config, so it must stamp the
    // shared marker explicitly after its relay-backed configuration succeeds.
    await markProviderGatewaySandboxCurrent(sandbox);
  } catch (error) {
    relay?.close();
    execBridge?.close();
    await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
    throw error;
  }

  let closed = false;
  return {
    authEpoch: runtime.authEpoch,
    async close() {
      if (closed) return;
      closed = true;
      await removeCodexProviderInstance(sandbox).catch(() => {});
      relay?.close();
      execBridge?.close();
      await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
    },
  };
}

export function buildCodexExecServerCommand(
  environmentId: string,
  layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT,
): string {
  assertSafeEnvironmentId(environmentId);
  return [
    "set -eu",
    `exec ${JSON.stringify(codexExecutable(layout))} exec-server --listen ws://0.0.0.0:${CODEX_EXEC_SERVER_PORT} --environment-id ${environmentId}`,
  ].join("\n");
}

export function buildCodexExecServerReadinessCommand(): string {
  const script = [
    'const net=require("node:net")',
    "const deadline=Date.now()+15000",
    "const probe=()=>{",
    `const socket=net.createConnection({host:"127.0.0.1",port:${CODEX_EXEC_SERVER_PORT}})`,
    "socket.once(\"connect\",()=>{socket.end();process.exit(0)})",
    "socket.once(\"error\",()=>{socket.destroy();Date.now()<deadline?setTimeout(probe,50):process.exit(1)})",
    "}",
    "probe()",
  ].join(";");
  return `node -e ${JSON.stringify(script)}`;
}

export function buildCodexProviderInstanceCommand(input: {
  readonly relayUrl: string;
  readonly environmentId: string;
  readonly workdir: string;
}, layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT): string {
  const providerInstance = {
    driver: "codex",
    displayName: CODEX_SUBSCRIPTION_DISPLAY_NAME,
    enabled: true,
    environment: [
      { name: "T3_CODEX_APP_SERVER_WS_URL", value: input.relayUrl, sensitive: true },
      {
        name: "T3_CODEX_TURN_ENVIRONMENTS",
        value: JSON.stringify([
          {
            environmentId: input.environmentId,
            cwd: input.workdir,
            runtimeWorkspaceRoots: [input.workdir],
          },
        ]),
        sensitive: false,
      },
    ],
    config: {
      enabled: true,
      binaryPath: codexExecutable(layout),
      homePath: "~/.codex",
      shadowHomePath: "",
      launchArgs: "",
      customModels: [],
    },
  };
  const patch = Buffer.from(JSON.stringify(providerInstance), "utf8").toString("base64");
  return [
    "set -eu",
    `SETTINGS="${RUNTIME_SETTINGS_PATH}"`,
    `export CODEX_INSTANCE_B64='${patch}'`,
    'node -e \'const fs=require("node:fs");const path=process.argv[1];const instance=JSON.parse(Buffer.from(process.env.CODEX_INSTANCE_B64,"base64").toString("utf8"));let current={};try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{};current.providerInstances={...(current.providerInstances??{}),codex:instance};const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)\' "$SETTINGS"',
  ].join("\n");
}

/** Probe that exits 0 only once T3 has published the subscription codex instance
 * into its provider status cache. Reads the cache CONTENT, not mtime: T3 rewrites
 * the cache for the legacy instance on every health refresh, so a fresh mtime is
 * a false positive. The subscription instance is the only codex instance we mark
 * with this display name, so its presence proves the relay-backed remote instance
 * is live. */
export function buildCodexProviderReadyProbeCommand(): string {
  const script = [
    'const fs=require("node:fs")',
    "let v",
    'try{v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}',
    `process.exit(v&&v.displayName===${JSON.stringify(CODEX_SUBSCRIPTION_DISPLAY_NAME)}?0:1)`,
  ].join(";");
  return [
    "set -eu",
    `node -e ${JSON.stringify(script)} ${JSON.stringify(CODEX_STATUS_CACHE_PATH)}`,
  ].join("\n");
}

/** Poll the sandbox until T3 reports the subscription codex instance in its
 * provider status cache, bounded by `deadlineMs`. Returns false on timeout or
 * abort so the caller can fall back to a deterministic T3 restart. Runs a plain
 * loopback exec, so it needs no T3 auth and works immediately after a restart. */
export async function awaitCodexProviderReady(
  sandbox: Pick<SandboxHandle, "process">,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<boolean> {
  const command = buildCodexProviderReadyProbeCommand();
  const deadline = Date.now() + deadlineMs;
  while (!signal.aborted) {
    const probe = await sandbox.process
      .executeCommand(command, undefined, undefined, 5)
      .catch(() => null);
    if ((probe?.exitCode ?? 1) === 0) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(CODEX_READY_POLL_MS);
  }
  return false;
}

function buildRemoveCodexProviderInstanceCommand(): string {
  return [
    "set -eu",
    `SETTINGS="${RUNTIME_SETTINGS_PATH}"`,
    'node -e \'const fs=require("node:fs");const path=process.argv[1];let current={};try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{};if(current.providerInstances){delete current.providerInstances.codex}const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)\' "$SETTINGS"',
  ].join("\n");
}

async function patchCodexProviderInstance(
  sandbox: SandboxHandle,
  input: Parameters<typeof buildCodexProviderInstanceCommand>[0],
  layout: SandboxRuntimeLayout,
): Promise<void> {
  const result = await sandbox.process.executeCommand(
    buildCodexProviderInstanceCommand(input, layout),
    undefined,
    undefined,
    10,
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("the provider runtime Codex subscription provider configuration failed");
  }
}

async function removeCodexProviderInstance(sandbox: SandboxHandle): Promise<void> {
  await sandbox.process.executeCommand(
    buildRemoveCodexProviderInstanceCommand(),
    undefined,
    undefined,
    10,
  );
}

export function previewWebSocketUrl(
  value: string,
  provider: ReturnType<typeof sandboxProviderKind>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Codex exec-server preview must use HTTP(S)");
  }
  assertTrustedPreviewHost(url, provider, env);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function assertTrustedPreviewHost(
  url: URL,
  provider: ReturnType<typeof sandboxProviderKind>,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (url.username || url.password) {
    throw new Error("Codex exec-server preview cannot contain URL credentials");
  }
  const problem = sandboxPlugin(provider).previewHostProblem(url, env);
  if (problem) throw new Error(problem);
}


function codexExecutionEnvironmentId(runId: string, sandboxId: string): string {
  const suffix = `${sandboxId}-${runId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `skynet-${suffix || "run"}`;
}

function assertSafeEnvironmentId(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error("Codex exec-server environment id is unsafe");
  }
}

function requiredIdentity(value: string | null | undefined, label: string): string {
  if (!value) throw new Error(`Codex subscription ${label} identity is required`);
  return value;
}
