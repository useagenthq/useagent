import { createHash, randomBytes } from "node:crypto";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";
import type { SandboxExecuteResult, SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { prefetchSandboxResult, takePrefetchedSandboxResult } from "../sandboxes/command-prefetch";
import { sandboxPlugin } from "../sandboxes/plugins";
import {
  previewLinkBase,
  sandboxProviderKind,
} from "../sandboxes/provider";
import { openCodexExecServerBridge } from "../provider-connections/codex-exec-server-bridge";
import { openCodexCodeModeBridge } from "../provider-connections/codex-code-mode-bridge";
import {
  openCodexRelaySession,
  type CodexRelaySession,
  type CodexRelaySessionScope,
} from "../provider-connections/codex-subscription-relay";
import type { CodexSubscriptionRuntimeSelection } from "../provider-connections/service";
import { findProviderThreadBinding } from "../provider-connections/repo";
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
import {
  buildSandboxListenerProbeCommand,
  LISTENER_FOREIGN,
  LISTENER_OURS,
  readListenerVerdicts,
  type SandboxListenerOwner,
} from "./sandbox-listener-probe";
import {
  buildCodexCodeModeLaunchCommand,
  buildCodexCodeModeTokenCommand,
  CODEX_CODE_MODE_FORWARDER_PORT,
  CODEX_CODE_MODE_HOST_PORT,
  CODEX_CODE_MODE_SESSION,
  codexCodeModeOwners,
} from "./codex-code-mode-sandbox";
import {
  claimCodexThreadSession,
  codexSessionReuseEnabled,
  codexThreadSessionKey,
  evictCodexThreadSession,
  keepCodexThreadSession,
  releaseCodexThreadSession,
  type CodexThreadSession,
  type CodexThreadSessionParts,
} from "./codex-thread-sessions";

const CODEX_EXEC_SERVER_PORT = 37_734;
const CODEX_EXEC_SERVER_SESSION = `${SANDBOX_NAME_PREFIX}-codex-exec-server`;
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
  readonly hasCurrentEpochThreadBinding: boolean;
  /** The runtime still holds this thread's Codex session from an earlier run:
   * its settings are current, so there is nothing to reconcile or wait for. */
  readonly sessionReused?: boolean;
  close(): Promise<void>;
}

interface SubscriptionDependencies {
  readonly openExecBridge: typeof openCodexExecServerBridge;
  readonly openCodeModeBridge: typeof openCodexCodeModeBridge;
  readonly openRelaySession: typeof openCodexRelaySession;
  readonly loadThreadBinding: typeof findProviderThreadBinding;
}

const defaultDependencies: SubscriptionDependencies = {
  openExecBridge: openCodexExecServerBridge,
  openCodeModeBridge: openCodexCodeModeBridge,
  openRelaySession: openCodexRelaySession,
  loadThreadBinding: findProviderThreadBinding,
};

/** What a kept thread session holds on this host: the relay and both bridges. */
interface SubscriptionSessionParts extends CodexThreadSessionParts {
  readonly cwd: string;
  /** The thread-scoped gateway bearer the session's app-server holds. */
  readonly toolGatewayBearer: string | null;
  readonly relay: CodexRelaySession;
  readonly codeModeBridge: ReturnType<typeof openCodexCodeModeBridge>;
}

export async function prepareCodexSubscription(input: {
  readonly sandbox: SandboxHandle;
  readonly ctx: EngineRunContext;
  readonly workdir: string;
  readonly runtime: CodexSubscriptionRuntimeSelection;
  readonly dependencies?: Partial<SubscriptionDependencies>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<CodexSubscriptionLease> {
  const { sandbox, ctx, workdir, runtime } = input;
  const reuse = codexSessionReuseEnabled(input.env);
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const orgId = requiredIdentity(ctx.orgId, "organization");
  const userId = requiredIdentity(ctx.userId, "user");
  const productThreadId = ctx.threadId ?? ctx.runId;
  const hasCurrentEpochThreadBinding = Boolean(await dependencies.loadThreadBinding({
    orgId,
    userId,
    productThreadId,
    connectionId: runtime.connectionId,
    authEpoch: runtime.authEpoch,
  }));
  const layout = codexRuntimeLayout(sandbox);
  const scope: CodexRelaySessionScope = {
    orgId,
    userId,
    threadId: productThreadId,
    connectionId: runtime.connectionId,
    authEpoch: runtime.authEpoch,
    sandboxId: sandbox.id,
    sandboxGeneration: RUNTIME_GENERATION,
    environmentId: codexExecutionEnvironmentId(sandbox.id),
    cwd: workdir,
  };
  const environmentId = scope.environmentId;
  const toolGateway = codexToolGatewayDescriptor(ctx);
  const run = {
    runId: ctx.runId,
    model: ctx.model?.trim() || DEFAULT_CODEX_MODEL,
  };
  const toolGatewayBearer = toolGateway?.bearerToken ?? null;
  const sessionKey = codexThreadSessionKey(scope);

  // One round trip: admit only this run's code-mode bearer from now on, then
  // ask who holds each service port. A retained sandbox keeps the services an
  // earlier turn started (the detached processes outlive their sessions), so
  // only a missing one is launched.
  const owners = codexServiceOwners(layout);
  const { codeModeBearer, probe } = await (
    takePrefetchedSandboxResult<CodexServicesProbe>(sandbox, CODEX_SERVICES_PROBE) ?? probeCodexServices(sandbox)
  );
  const verdicts = assertNoForeignListener(readListenerVerdicts(probe?.result ?? "", owners));
  const servicesUp = owners.every(({ port }) => verdicts[port] === LISTENER_OURS);

  // A follow-up turn on a sandbox whose services never went away takes the
  // thread's kept session: the runtime's Codex session is still connected to
  // it, so the run only becomes the one it serves. Its app-server holds the
  // gateway bearer it started with, so it serves only runs given that same
  // bearer: once the thread's bearer is re-minted, a fresh session starts.
  if (reuse && servicesUp) {
    const kept = claimCodexThreadSession<SubscriptionSessionParts>(sessionKey);
    if (
      kept && !kept.parts.relay.closed && kept.parts.cwd === workdir &&
      kept.parts.toolGatewayBearer === toolGatewayBearer
    ) {
      kept.parts.codeModeBridge.rotateBearer(codeModeBearer);
      kept.parts.relay.activate(run);
      return {
        authEpoch: runtime.authEpoch,
        hasCurrentEpochThreadBinding,
        sessionReused: true,
        close: releaseWhenDone(kept),
      };
    }
  }
  // Restarted services or a stale session: whatever this host kept is unusable.
  evictCodexThreadSession(sessionKey, servicesUp ? "stale" : "sandbox services restarted");

  let execBridge: ReturnType<typeof openCodexExecServerBridge> | undefined;
  let codeModeBridge: ReturnType<typeof openCodexCodeModeBridge> | undefined;
  let relay: CodexRelaySession | undefined;
  try {
    await launchMissingCodexServices(sandbox, layout, verdicts);

    const sandboxKind = sandbox.providerKind ?? sandboxProviderKind();
    const [execPreview, codeModePreview] = await Promise.all([
      sandbox.getPreviewLink(CODEX_EXEC_SERVER_PORT),
      sandbox.getPreviewLink(CODEX_CODE_MODE_FORWARDER_PORT),
    ]);
    const upstreamUrl = previewWebSocketUrl(execPreview.url, sandboxKind);
    execBridge = dependencies.openExecBridge({
      upstreamUrl,
      expectedUpstreamHost: new URL(upstreamUrl).host,
      headers: { ...previewLinkBase(execPreview).headers },
    });
    const codeModeUrl = previewWebSocketUrl(codeModePreview.url, sandboxKind);
    codeModeBridge = dependencies.openCodeModeBridge({
      upstreamUrl: codeModeUrl,
      expectedUpstreamHost: new URL(codeModeUrl).host,
      headers: { ...previewLinkBase(codeModePreview).headers },
      bearerToken: codeModeBearer,
    });
    relay = dependencies.openRelaySession({
      scope,
      runtime,
      execServerUrl: execBridge.url,
      codeModeHostUrl: codeModeBridge.url,
      toolGateway: toolGateway
        ? { serverName: toolGateway.serverName, url: toolGateway.url, bearerToken: toolGateway.bearerToken }
        : null,
      reusable: reuse,
    });
    relay.activate(run);
    // Retained-sandbox validation requires both the immutable control-plane
    // generation label and this on-disk marker. Subscription-backed Codex does
    // not materialize the provider-gateway model config, so it stamps the
    // shared marker itself; a failed relay configuration still fails the turn.
    await Promise.all([
      patchCodexProviderInstance(sandbox, {
        relayUrl: relay.url,
        environmentId,
        workdir,
      }, layout),
      markProviderGatewaySandboxCurrent(sandbox),
    ]);
  } catch (error) {
    relay?.close();
    codeModeBridge?.close();
    execBridge?.close();
    await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
    throw error;
  }

  const ownedRelay = relay;
  const ownedCodeModeBridge = codeModeBridge;
  const ownedExecBridge = execBridge;
  const parts: SubscriptionSessionParts = {
    environmentId,
    cwd: workdir,
    toolGatewayBearer,
    relay: ownedRelay,
    codeModeBridge: ownedCodeModeBridge,
    close() {
      ownedRelay.close();
      ownedCodeModeBridge.close();
      ownedExecBridge.close();
    },
  };
  // Kept for the thread's next runs when the host has room; otherwise this
  // run's session is its own and goes with it, as before.
  const kept = reuse ? keepCodexThreadSession(sessionKey, userId, parts) : null;
  if (kept) {
    return {
      authEpoch: runtime.authEpoch,
      hasCurrentEpochThreadBinding,
      sessionReused: false,
      close: releaseWhenDone(kept),
    };
  }
  let closed = false;
  return {
    authEpoch: runtime.authEpoch,
    hasCurrentEpochThreadBinding,
    sessionReused: false,
    async close() {
      if (closed) return;
      closed = true;
      await removeCodexProviderInstance(sandbox).catch(() => {});
      parts.close();
      await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
    },
  };
}

/** Start whichever Codex services the probe found missing, then wait until our
 * own processes hold all three ports. */
async function launchMissingCodexServices(
  sandbox: SandboxHandle,
  layout: SandboxRuntimeLayout,
  verdicts: NonNullable<ReturnType<typeof readListenerVerdicts>>,
): Promise<void> {
  const owners = codexServiceOwners(layout);
  if (owners.every(({ port }) => verdicts[port] === LISTENER_OURS)) return;
  if (verdicts[CODEX_EXEC_SERVER_PORT] !== LISTENER_OURS) {
    await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
    await sandbox.process.createSession(CODEX_EXEC_SERVER_SESSION);
    const launch = await sandbox.process.executeSessionCommand(
      CODEX_EXEC_SERVER_SESSION,
      {
        command: buildCodexExecServerCommand(codexExecutionEnvironmentId(sandbox.id), layout),
        runAsync: true,
        suppressInputEcho: true,
      },
      30,
    );
    if ((launch.exitCode ?? 0) !== 0) throw new Error("Codex exec-server failed to start");
  }
  const startCodeMode = {
    host: verdicts[CODEX_CODE_MODE_HOST_PORT] !== LISTENER_OURS,
    forwarder: verdicts[CODEX_CODE_MODE_FORWARDER_PORT] !== LISTENER_OURS,
  };
  if (startCodeMode.host || startCodeMode.forwarder) {
    await sandbox.process.createSession(CODEX_CODE_MODE_SESSION);
    const launch = await sandbox.process.executeSessionCommand(
      CODEX_CODE_MODE_SESSION,
      { command: buildCodexCodeModeLaunchCommand(layout, startCodeMode), runAsync: true, suppressInputEcho: true },
      30,
    );
    if ((launch.exitCode ?? 0) !== 0) throw new Error("Codex code-mode host failed to start");
  }
  const readiness = await sandbox.process.executeCommand(
    buildSandboxListenerProbeCommand(owners, 15_000),
    undefined,
    undefined,
    20,
  ).catch(() => null);
  const ready = assertNoForeignListener(readListenerVerdicts(readiness?.result ?? "", owners));
  if (owners.some(({ port }) => ready[port] !== LISTENER_OURS)) {
    throw new Error("Codex sandbox services failed readiness");
  }
}

/** A warm-pool sandbox starts the Codex services before any run claims it, so
 * a new thread's first Codex turn finds them up. No bearer digest is written:
 * the forwarder refuses every connection until a run admits its own. */
export async function prewarmCodexServices(sandbox: SandboxHandle): Promise<void> {
  const layout = codexRuntimeLayout(sandbox);
  const owners = codexServiceOwners(layout);
  const probe = await sandbox.process.executeCommand(
    buildSandboxListenerProbeCommand(owners, 0),
    undefined,
    undefined,
    10,
  ).catch(() => null);
  await launchMissingCodexServices(sandbox, layout, assertNoForeignListener(readListenerVerdicts(probe?.result ?? "", owners)));
}

const CODEX_SERVICES_PROBE = "codex-services-probe";

interface CodexServicesProbe {
  readonly codeModeBearer: string;
  readonly probe: SandboxExecuteResult | null;
}

function codexServiceOwners(layout: SandboxRuntimeLayout) {
  return [codexExecServerOwner(layout), ...codexCodeModeOwners(layout)];
}

/** One round trip with a fresh code-mode bearer: admit only it from now on, and
 * report who holds each service port. */
async function probeCodexServices(sandbox: SandboxHandle): Promise<CodexServicesProbe> {
  const layout = codexRuntimeLayout(sandbox);
  const codeModeBearer = randomBytes(32).toString("hex");
  const probe = await sandbox.process.executeCommand(
    `${buildCodexCodeModeTokenCommand(createHash("sha256").update(codeModeBearer).digest("hex"), layout)} && ` +
      buildSandboxListenerProbeCommand(codexServiceOwners(layout), 0),
    undefined,
    undefined,
    10,
  ).catch(() => null);
  return { codeModeBearer, probe };
}

/** Start a warm turn's services probe alongside sandbox acquisition; the
 * turn's subscription preparation takes it, bearer and all. */
export function prefetchCodexServicesProbe(sandbox: SandboxHandle): void {
  prefetchSandboxResult(sandbox, CODEX_SERVICES_PROBE, () => probeCodexServices(sandbox));
}

/** The run is done: its kept session serves no run, so the relay refuses
 * connections and turn starts until the thread's next run takes it. */
function releaseWhenDone(kept: CodexThreadSession<SubscriptionSessionParts>): () => Promise<void> {
  return async () => {
    kept.parts.relay.deactivate();
    releaseCodexThreadSession(kept);
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

/** The exec-server as the process that must own its port: the installed native
 * Codex binary running `exec-server --listen` on it. */
export function codexExecServerOwner(layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT): SandboxListenerOwner {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  return {
    address: "0.0.0.0",
    port: CODEX_EXEC_SERVER_PORT,
    executable: "codex",
    installRoot: `${prefix}/share/useagent/native-engines`,
    args: ["exec-server", "--listen", `ws://0.0.0.0:${CODEX_EXEC_SERVER_PORT}`],
  };
}

/** Exits 0 once the exec-server port is held by our exec-server, 1 if nothing
 * listens by the deadline, 2 as soon as anything else holds it. */
export function buildCodexExecServerReadinessCommand(
  deadlineMs = 15_000,
  layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT,
): string {
  return buildSandboxListenerProbeCommand([codexExecServerOwner(layout)], deadlineMs);
}

/** The verdicts, once no service port is held by another process. */
function assertNoForeignListener(
  verdicts: ReturnType<typeof readListenerVerdicts>,
): NonNullable<ReturnType<typeof readListenerVerdicts>> {
  if (!verdicts) throw new Error("Codex sandbox services could not be probed");
  const taken = Object.entries(verdicts).find(([, verdict]) => verdict === LISTENER_FOREIGN)?.[0];
  if (taken) throw new Error(`Codex service port ${taken} is held by another process in the sandbox`);
  return verdicts;
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


/** The remote environment of a sandbox's one exec-server, which every run on
 * the sandbox shares and a warm pool can start before any thread claims it. */
function codexExecutionEnvironmentId(sandboxId: string): string {
  const suffix = sandboxId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return `${SANDBOX_NAME_PREFIX}-${suffix || "run"}`;
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
