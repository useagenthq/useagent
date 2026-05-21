import type { SandboxHandle } from "../sandboxes/provider";
import {
  sandboxPreviewHeaders,
  sandboxProviderKind,
} from "../sandboxes/provider";
import { openCodexExecServerBridge } from "../provider-connections/codex-exec-server-bridge";
import {
  issueCodexSubscriptionRelayCapability,
  type CodexSubscriptionRelayBinding,
} from "../provider-connections/codex-subscription-relay";
import type { CodexSubscriptionRuntimeSelection } from "../provider-connections/service";
import { DEFAULT_CODEX_MODEL } from "../runs/model-policy";
import { codexToolGatewayDescriptor } from "../provider-gateway/sandbox-config";
import type { EngineRunContext } from "./types";
import { T3_ENVIRONMENT_HOME, T3_RUNTIME_GENERATION } from "./t3-environment";

const CODEX_EXEC_SERVER_PORT = 37_734;
const CODEX_EXEC_SERVER_SESSION = "skynet-codex-exec-server";
const T3_SETTINGS_PATH = `${T3_ENVIRONMENT_HOME}/userdata/settings.json`;

export interface T3CodexSubscriptionLease {
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

export async function prepareT3CodexSubscription(input: {
  readonly sandbox: SandboxHandle;
  readonly ctx: EngineRunContext;
  readonly workdir: string;
  readonly runtime: CodexSubscriptionRuntimeSelection;
  readonly dependencies?: SubscriptionDependencies;
}): Promise<T3CodexSubscriptionLease> {
  const { sandbox, ctx, workdir, runtime } = input;
  const dependencies = input.dependencies ?? defaultDependencies;
  const orgId = requiredIdentity(ctx.orgId, "organization");
  const userId = requiredIdentity(ctx.userId, "user");
  const environmentId = codexExecutionEnvironmentId(ctx.runId, sandbox.id);
  let execBridge: ReturnType<typeof openCodexExecServerBridge> | undefined;
  let relay: ReturnType<typeof issueCodexSubscriptionRelayCapability> | undefined;

  await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
  await sandbox.process.createSession(CODEX_EXEC_SERVER_SESSION);
  const launch = await sandbox.process.executeSessionCommand(
    CODEX_EXEC_SERVER_SESSION,
    {
      command: buildCodexExecServerCommand(environmentId),
      runAsync: true,
      suppressInputEcho: true,
    },
    30,
  );
  if ((launch.exitCode ?? 0) !== 0) {
    throw new Error("Codex exec-server failed to start");
  }

  try {
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
    const upstreamUrl = previewWebSocketUrl(preview.url, sandboxProviderKind());
    execBridge = dependencies.openExecBridge({
      upstreamUrl,
      expectedUpstreamHost: new URL(upstreamUrl).host,
      headers: sandboxPreviewHeaders(preview.token ?? "", sandboxProviderKind()),
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
      sandboxGeneration: T3_RUNTIME_GENERATION,
      environmentId,
      cwd: workdir,
    };
    relay = dependencies.issueRelay({
      binding,
      runtime,
      execServerUrl: execBridge.url,
      toolGateway: codexToolGatewayDescriptor(ctx),
    });
    await patchT3CodexProviderInstance(sandbox, {
      relayUrl: relay.url,
      environmentId,
      workdir,
    });
  } catch (error) {
    relay?.close();
    execBridge?.close();
    await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
    throw error;
  }

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await removeT3CodexProviderInstance(sandbox).catch(() => {});
      relay?.close();
      execBridge?.close();
      await sandbox.process.deleteSession(CODEX_EXEC_SERVER_SESSION).catch(() => {});
    },
  };
}

export function buildCodexExecServerCommand(environmentId: string): string {
  assertSafeEnvironmentId(environmentId);
  return [
    "set -eu",
    `exec codex exec-server --listen ws://0.0.0.0:${CODEX_EXEC_SERVER_PORT} --environment-id ${environmentId}`,
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

export function buildT3CodexProviderInstanceCommand(input: {
  readonly relayUrl: string;
  readonly environmentId: string;
  readonly workdir: string;
}): string {
  const providerInstance = {
    driver: "codex",
    displayName: "Codex subscription",
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
      binaryPath: "codex",
      homePath: "~/.codex",
      shadowHomePath: "",
      launchArgs: "",
      customModels: [],
    },
  };
  const patch = Buffer.from(JSON.stringify(providerInstance), "utf8").toString("base64");
  return [
    "set -eu",
    `SETTINGS="${T3_SETTINGS_PATH}"`,
    `export CODEX_INSTANCE_B64='${patch}'`,
    'node -e \'const fs=require("node:fs");const path=process.argv[1];const instance=JSON.parse(Buffer.from(process.env.CODEX_INSTANCE_B64,"base64").toString("utf8"));let current={};try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{};current.providerInstances={...(current.providerInstances??{}),codex:instance};const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)\' "$SETTINGS"',
  ].join("\n");
}

function buildRemoveT3CodexProviderInstanceCommand(): string {
  return [
    "set -eu",
    `SETTINGS="${T3_SETTINGS_PATH}"`,
    'node -e \'const fs=require("node:fs");const path=process.argv[1];let current={};try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{};if(current.providerInstances){delete current.providerInstances.codex}const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)\' "$SETTINGS"',
  ].join("\n");
}

async function patchT3CodexProviderInstance(
  sandbox: SandboxHandle,
  input: Parameters<typeof buildT3CodexProviderInstanceCommand>[0],
): Promise<void> {
  const result = await sandbox.process.executeCommand(
    buildT3CodexProviderInstanceCommand(input),
    undefined,
    undefined,
    10,
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("T3 Codex subscription provider configuration failed");
  }
}

async function removeT3CodexProviderInstance(sandbox: SandboxHandle): Promise<void> {
  await sandbox.process.executeCommand(
    buildRemoveT3CodexProviderInstanceCommand(),
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
  const hostname = url.hostname.toLowerCase();
  if (provider === "cube") {
    const domain = env.CUBE_SANDBOX_DOMAIN?.trim().toLowerCase() || "cube.app";
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
      throw new Error("Codex exec-server preview is outside the Cube sandbox domain");
    }
    return;
  }
  if (env.NODE_ENV !== "test" && url.protocol !== "https:") {
    throw new Error("Daytona exec-server preview must use HTTPS");
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    isPrivateIpLiteral(hostname)
  ) {
    throw new Error("Codex exec-server preview host is unavailable");
  }
}

function isPrivateIpLiteral(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return hostname === "::1" || hostname.startsWith("fe80:") || hostname.startsWith("fc") || hostname.startsWith("fd");
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return true;
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
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
