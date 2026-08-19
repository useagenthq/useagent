import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { env } from "../env";
import type { AppEnv } from "../http";
import { codexAppServerChildEnvironment } from "./codex-app-server";
import type { ToolGatewayCapabilityDescriptor } from "../knowledge/gateway/descriptor";
import {
  getCodexSubscriptionRuntimeSelection,
  type CodexSubscriptionRuntimeSelection,
} from "./service";
import { bindProviderThread, findProviderThreadBinding } from "./repo";
import { CodexSubscriptionProtocol } from "./codex-subscription-protocol";
import { createCodexRemoteEnvironmentBootstrap } from "./codex-remote-environment-bootstrap";
import { createSerialTaskQueue } from "./serial-task-queue";
import {
  attachCodexSubscriptionAppServer,
  startCodexSubscriptionAppServer,
  suppressCodexSubscriptionStartupRejection,
} from "./codex-subscription-app-server";

const DEFAULT_CAPABILITY_TTL_MS = 2 * 60_000;
const RELAY_PATH_PREFIX = "/api/internal/codex-relay/";

export interface CodexSubscriptionRelayBinding {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly connectionId: string;
  readonly authEpoch: string;
  readonly model: string;
  readonly sandboxId: string;
  readonly sandboxGeneration: string;
  readonly environmentId: string;
  readonly cwd: string;
}

export interface CodexSubscriptionRelayCapability {
  readonly url: string;
  close(): void;
}

interface RelayGrant {
  readonly binding: CodexSubscriptionRelayBinding;
  readonly codexHome: string;
  readonly execServerUrl: string;
  readonly toolGateway: ToolGatewayCapabilityDescriptor | null;
  readonly expiresAt: number;
  consumed: boolean;
}

interface RelayDependencies {
  readonly now: () => number;
  readonly selectRuntime: typeof getCodexSubscriptionRuntimeSelection;
  readonly spawnAppServer: (input: {
    readonly codexHome: string;
    readonly execServerUrl: string;
    readonly toolGateway: ToolGatewayCapabilityDescriptor | null;
  }) => ChildProcessWithoutNullStreams;
  readonly loadThreadBinding: (binding: CodexSubscriptionRelayBinding) => Promise<string | null>;
  readonly bindThread: (
    binding: CodexSubscriptionRelayBinding & { readonly providerThreadId: string },
  ) => Promise<void>;
}

const grants = new Map<string, RelayGrant>();

const defaultDependencies: RelayDependencies = {
  now: Date.now,
  selectRuntime: getCodexSubscriptionRuntimeSelection,
  spawnAppServer: ({ codexHome, toolGateway }) =>
    spawn("codex", [
      "app-server",
      "--stdio",
      ...(toolGateway
        ? [
            "-c",
            `mcp_servers.${toolGateway.serverName}.url=${JSON.stringify(toolGateway.url)}`,
            "-c",
            `mcp_servers.${toolGateway.serverName}.bearer_token_env_var=\"SKYNET_TOOL_GATEWAY_BEARER_TOKEN\"`,
          ]
        : []),
    ], {
      env: {
        ...codexAppServerChildEnvironment(codexHome),
        ...(toolGateway
          ? { SKYNET_TOOL_GATEWAY_BEARER_TOKEN: toolGateway.bearerToken }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  loadThreadBinding: (binding) => findProviderThreadBinding(threadBindingScope(binding)),
  bindThread: (binding) => bindProviderThread({
    ...threadBindingScope(binding),
    providerThreadId: binding.providerThreadId,
  }),
};

let dependencies = defaultDependencies;

export function issueCodexSubscriptionRelayCapability(input: {
  readonly binding: CodexSubscriptionRelayBinding;
  readonly runtime: CodexSubscriptionRuntimeSelection;
  readonly execServerUrl: string;
  readonly toolGateway?: ToolGatewayCapabilityDescriptor | null;
  readonly ttlMs?: number;
  readonly publicOrigin?: string;
}): CodexSubscriptionRelayCapability {
  pruneExpiredGrants(dependencies.now());
  assertLoopbackWebSocket(input.execServerUrl);
  assertRuntimeMatchesBinding(input.runtime, input.binding);
  const token = crypto.randomUUID();
  const key = capabilityKey(token);
  grants.set(key, {
    binding: structuredClone(input.binding),
    codexHome: input.runtime.codexHome,
    execServerUrl: input.execServerUrl,
    toolGateway: input.toolGateway ?? null,
    expiresAt: dependencies.now() + (input.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS),
    consumed: false,
  });
  const origin = new URL(input.publicOrigin ?? env.BETTER_AUTH_URL);
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = `${RELAY_PATH_PREFIX}${token}`;
  origin.search = "";
  origin.hash = "";

  return {
    url: origin.toString(),
    close() {
      grants.delete(key);
    },
  };
}

export const codexSubscriptionRelayRoutes = new Hono<AppEnv>();

codexSubscriptionRelayRoutes.get(
  "/:capability",
  upgradeWebSocket((context) => {
    pruneExpiredGrants(dependencies.now());
    const token = context.req.param("capability") ?? "";
    const key = capabilityKey(token);
    const grant = grants.get(key);
    const browserOrigin = context.req.header("origin");
    const accepted = Boolean(
      grant && !browserOrigin && !grant.consumed && grant.expiresAt > dependencies.now(),
    );
    // Token-free relay visibility: the capability token is never logged; the runId
    // correlates the sandbox dial with the run. Explains whether the sandbox
    // reached the relay at all and why a capability was refused.
    const relayRunId = grant?.binding.runId;
    const validation = accepted
      ? "accepted"
      : !grant
        ? "unknown-capability"
        : browserOrigin
          ? "rejected-browser-origin"
          : grant.consumed
            ? "rejected-consumed"
            : "rejected-expired";
    console.log(
      `[codex-relay] capability ${validation}${relayRunId ? ` run=${relayRunId}` : ""}`,
    );
    if (grant && browserOrigin) grants.delete(key);
    if (grant && accepted) grant.consumed = true;
    let child: ChildProcessWithoutNullStreams | null = null;
    let closed = false;
    const protocol = grant
      ? new CodexSubscriptionProtocol(grant.binding, {
          loadThreadBinding: () => dependencies.loadThreadBinding(grant.binding),
          bindThread: (providerThreadId) => dependencies.bindThread({
            ...grant.binding,
            providerThreadId,
          }),
        })
      : null;
    const environmentBootstrap = grant
      ? createCodexRemoteEnvironmentBootstrap({
          environmentId: grant.binding.environmentId,
          execServerUrl: grant.execServerUrl,
        })
      : null;
    const childReady = accepted && grant
      ? startCodexSubscriptionAppServer({
          authorize: () => authorizeGrant(grant),
          isClosed: () => closed,
          spawn: () => dependencies.spawnAppServer({
            codexHome: grant.codexHome,
            execServerUrl: grant.execServerUrl,
            toolGateway: grant.toolGateway,
          }),
          onSpawn: (process) => {
            child = process;
          },
        })
      : Promise.reject(new Error("invalid or expired capability"));
    // Invalid capabilities never await this promise. Attach a rejection
    // handler immediately so a rejected authorization cannot surface as an
    // unhandled process-level rejection before the socket open callback runs.
    void suppressCodexSubscriptionStartupRejection(childReady);

    const closeChild = () => {
      const active = child;
      child = null;
      if (!active || active.killed) return;
      active.kill("SIGTERM");
    };
    let relaySocket: { close(code?: number, reason?: string): void } | null = null;
    const rejectRelay = (error: unknown) => {
      // The rejection REASON must be visible in operations: a silent 1008 close
      // reads as "no first activity" at the run layer and hides the real cause
      // (binding mismatch, oversized frame, disconnected subscription). Frame
      // CONTENT is never logged - only the protocol error message.
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`[codex-relay] frame rejected run=${relayRunId}: ${reason}`);
      relaySocket?.close(1008, "relay frame rejected");
      relaySocket = null;
      closed = true;
      environmentBootstrap?.close();
      closeChild();
    };
    const clientFrames = createSerialTaskQueue(rejectRelay);
    const serverFrames = createSerialTaskQueue(rejectRelay);

    return {
      onOpen: (_event, socket) => {
        relaySocket = socket;
        if (!grant || !accepted) {
          socket.close(1008, "invalid or expired capability");
          return;
        }
        console.log(`[codex-relay] connection open run=${relayRunId}`);
        grants.delete(key);
        void attachCodexSubscriptionAppServer({
          childReady,
          isClosed: () => closed,
          closeChild,
          onChildClosed: () => {
            child = null;
          },
          onLine: (line) => serverFrames.enqueue(async () => {
            await authorizeGrant(grant);
            if (!protocol || !environmentBootstrap) {
              throw new Error("Codex relay protocol is unavailable");
            }
            const forwarded = await environmentBootstrap.acceptServerFrame(line);
            for (const frame of forwarded) {
              await protocol.observeServerFrame(frame);
              socket.send(frame);
            }
          }),
          closeSocket: (code, reason) => socket.close(code, reason),
        });
      },
      onMessage: (event, socket) => {
        relaySocket = socket;
        if (!grant || !accepted) return;
        const frame = typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        clientFrames.enqueue(async () => {
          const process = await childReady;
          await authorizeGrant(grant);
          if (!protocol || !environmentBootstrap) {
            throw new Error("Codex relay protocol is unavailable");
          }
          // The protocol may rewrite the frame (bound-thread `thread/start`
          // becomes `thread/resume`); everything downstream sees the outbound.
          const outbound = await protocol.acceptClientFrame(frame);
          if (!process.stdin.writable) throw new Error("Codex app-server is unavailable");
          const forwarded = await environmentBootstrap.acceptClientFrame(outbound);
          for (const childFrame of forwarded) process.stdin.write(`${childFrame}\n`);
        });
      },
      onClose: () => {
        if (accepted) console.log(`[codex-relay] connection closed run=${relayRunId}`);
        closed = true;
        relaySocket = null;
        grants.delete(key);
        environmentBootstrap?.close();
        closeChild();
      },
    };
  }),
);

async function authorizeGrant(grant: RelayGrant): Promise<void> {
  const runtime = await dependencies.selectRuntime({
    orgId: grant.binding.orgId,
    userId: grant.binding.userId,
    provider: "openai",
  });
  if (!runtime) throw new Error("Codex subscription is disconnected");
  assertRuntimeMatchesBinding(runtime, grant.binding);
}

function assertRuntimeMatchesBinding(
  runtime: CodexSubscriptionRuntimeSelection,
  binding: Pick<CodexSubscriptionRelayBinding, "connectionId" | "authEpoch">,
): void {
  if (
    runtime.connectionId !== binding.connectionId ||
    runtime.authEpoch !== binding.authEpoch
  ) {
    throw new Error("Codex subscription authorization changed");
  }
}

function threadBindingScope(binding: CodexSubscriptionRelayBinding) {
  return {
    orgId: binding.orgId,
    userId: binding.userId,
    productThreadId: binding.threadId,
    connectionId: binding.connectionId,
    authEpoch: binding.authEpoch,
  };
}

function capabilityKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneExpiredGrants(now: number): void {
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(key);
  }
}

function assertLoopbackWebSocket(value: string): void {
  const url = new URL(value);
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1")
  ) {
    throw new Error("Codex app-server exec bridge must be a loopback websocket");
  }
}

export function setCodexSubscriptionRelayDependenciesForTest(
  overrides: Partial<RelayDependencies> | null,
): void {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
  grants.clear();
}
