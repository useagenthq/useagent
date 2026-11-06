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
import { CodexSubscriptionProtocol, parseCodexSubscriptionFrame } from "./codex-subscription-protocol";
import { createCodexRemoteEnvironmentBootstrap } from "./codex-remote-environment-bootstrap";
import { createSerialTaskQueue } from "./serial-task-queue";
import {
  attachCodexSubscriptionAppServer,
  startCodexSubscriptionAppServer,
  suppressCodexSubscriptionStartupRejection,
} from "./codex-subscription-app-server";
import { errorMessage } from "../util/error-message";
import { prepareCodexServerFrame } from "./codex-native-output";
import { importCodexNativeOutput } from "./codex-native-output-import";

const DEFAULT_CAPABILITY_TTL_MS = 2 * 60_000;
// One run may start its turn and the plane's one continuation of it (a
// compaction counts as one); anything more is not the plane speaking. Steering
// adds to a turn that is already running, so it only needs the run.
const MAX_TURN_STARTS_PER_RUN = 2;
const RUN_BOUND_METHODS = new Set(["turn/start", "turn/steer", "thread/compact/start"]);
const TURN_STARTING_METHODS = new Set(["turn/start", "thread/compact/start"]);
const MAX_REMEMBERED_TURNS = 64;
const RELAY_PATH_PREFIX = "/api/internal/codex-relay/";
const CODEX_PLAN_TOOL_OVERRIDE = "tools.update_plan.enabled=true";
// This app-server runs on the backend host. Every default-on feature that could
// start a process, browser or plugin here stays off; shell and file tools reach
// the sandbox through the run's remote environment. ChatGPT Apps (codex_apps)
// are not part of the product's tool surface either, and every turn waited on
// their startup. Model-written code-mode JavaScript runs in the sandbox's
// code-mode host (see codexSubscriptionAppServerArgs).
const HOST_EXECUTION_FEATURES_OFF = [
  "apps", "plugins", "remote_plugin", "plugin_sharing", "tool_suggest", "skill_mcp_dependency_install",
  "hooks", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
  "in_app_browser", "in_app_local_automation", "shell_snapshot",
  // Native goals let Codex start turns on its own, outside admission and spend checks.
  "goals",
].flatMap((feature) => ["-c", `features.${feature}=false`]);

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

/** What a relay session is bound to for its whole life; the run and its model change per turn. */
export type CodexRelaySessionScope = Omit<CodexSubscriptionRelayBinding, "runId" | "model">;

/** The run a relay session serves until it is deactivated. */
export interface CodexRelayRun {
  readonly runId: string;
  readonly model: string;
}

export interface CodexSubscriptionRelayCapability {
  readonly url: string;
  close(): void;
}

/** A relay endpoint the sandbox's runtime dials. Reusable sessions outlive their
 * runs and accept a new connection after the last one closed; single-use ones
 * accept exactly one connection, within the capability window. */
export interface CodexRelaySession extends CodexSubscriptionRelayCapability {
  /** Serve `run` from now on, with its model. */
  activate(run: CodexRelayRun): void;
  /** Serve no run: turn starts and new connections are refused. */
  deactivate(): void;
  /** Whether a runtime connection is open on this session right now. */
  readonly connected: boolean;
  readonly closed: boolean;
}

export function codexSubscriptionRelayPublicOrigin(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = source.CODEX_SUBSCRIPTION_RELAY_PUBLIC_ORIGIN?.trim();
  const origin = new URL(configured || env.BETTER_AUTH_URL);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("CODEX_SUBSCRIPTION_RELAY_PUBLIC_ORIGIN must be an HTTP(S) origin");
  }
  return origin.origin;
}

/** The MCP server the app-server reaches the tool gateway through. A kept
 * session serves one thread and user, so its bearer is the thread-scoped one:
 * the gateway acts as whichever of the thread's runs is live and refuses
 * between runs. */
export type RelayToolGateway = Pick<ToolGatewayCapabilityDescriptor, "serverName" | "url" | "bearerToken">;

interface RelaySessionState {
  readonly scope: CodexRelaySessionScope;
  readonly codexHome: string;
  readonly execServerUrl: string;
  readonly codeModeHostUrl: string;
  readonly toolGateway: RelayToolGateway | null;
  readonly reusable: boolean;
  readonly expiresAt: number;
  connections: number;
  live: boolean;
  closed: boolean;
  run: (CodexRelayRun & { turnStarts: number }) | null;
  /** Provider turn id -> the run that started it, for attributing native output. */
  readonly turnRuns: Map<string, string>;
  /** Ends the live connection and its app-server; set while one is open. */
  disconnect: (() => void) | null;
}

interface RelayDependencies {
  readonly now: () => number;
  readonly selectRuntime: typeof getCodexSubscriptionRuntimeSelection;
  readonly spawnAppServer: (input: {
    readonly codexHome: string;
    readonly execServerUrl: string;
    readonly codeModeHostUrl: string;
    readonly toolGateway: RelayToolGateway | null;
  }) => ChildProcessWithoutNullStreams;
  readonly loadThreadBinding: (scope: CodexRelaySessionScope) => Promise<string | null>;
  readonly bindThread: (
    scope: CodexRelaySessionScope & { readonly providerThreadId: string },
  ) => Promise<void>;
}

const sessions = new Map<string, RelaySessionState>();

/** The app-server's arguments. Model-written code-mode JavaScript runs in the
 * sandbox's code-mode host at `codeModeHostUrl` (a loopback tunnel), never in a
 * host process this backend would otherwise start. The tool gateway's bearer is
 * read from the environment, never the arguments, and no helper process runs:
 * Codex would start one in the thread's cwd, which exists only in the sandbox. */
export function codexSubscriptionAppServerArgs(
  toolGateway: RelayToolGateway | null,
  codeModeHostUrl: string,
): string[] {
  assertLoopbackUrl(codeModeHostUrl, ["http:"], "Codex code-mode host must be a loopback HTTP tunnel");
  return [
    "app-server",
    "--stdio",
    "--code-mode-host",
    codeModeHostUrl,
    "-c",
    CODEX_PLAN_TOOL_OVERRIDE,
    ...HOST_EXECUTION_FEATURES_OFF,
    ...(toolGateway
      ? [
          "-c",
          `mcp_servers.${toolGateway.serverName}.url=${JSON.stringify(toolGateway.url)}`,
          "-c",
          `mcp_servers.${toolGateway.serverName}.bearer_token_env_var="USEAGENT_TOOL_GATEWAY_BEARER_TOKEN"`,
        ]
      : []),
  ];
}

/** The app-server's environment: the account's scoped home and the gateway
 * bearer its MCP client reads (`bearer_token_env_var` in the arguments). */
export function codexSubscriptionAppServerEnvironment(
  codexHome: string,
  toolGateway: RelayToolGateway | null,
): Record<string, string> {
  return {
    ...codexAppServerChildEnvironment(codexHome),
    ...(toolGateway
      ? { USEAGENT_TOOL_GATEWAY_BEARER_TOKEN: toolGateway.bearerToken }
      : {}),
  };
}

const defaultDependencies: RelayDependencies = {
  now: Date.now,
  selectRuntime: getCodexSubscriptionRuntimeSelection,
  spawnAppServer: ({ codexHome, toolGateway, codeModeHostUrl }) =>
    spawn("codex", codexSubscriptionAppServerArgs(toolGateway, codeModeHostUrl), {
      env: codexSubscriptionAppServerEnvironment(codexHome, toolGateway),
      stdio: ["pipe", "pipe", "pipe"],
    }),
  loadThreadBinding: (scope) => findProviderThreadBinding(threadBindingScope(scope)),
  bindThread: (scope) => bindProviderThread({
    ...threadBindingScope(scope),
    providerThreadId: scope.providerThreadId,
  }),
};

let dependencies = defaultDependencies;

export function openCodexRelaySession(input: {
  readonly scope: CodexRelaySessionScope;
  readonly runtime: CodexSubscriptionRuntimeSelection;
  readonly execServerUrl: string;
  readonly codeModeHostUrl: string;
  readonly toolGateway: RelayToolGateway | null;
  readonly reusable: boolean;
  readonly ttlMs?: number;
  readonly publicOrigin?: string;
}): CodexRelaySession {
  pruneExpiredSessions(dependencies.now());
  assertLoopbackUrl(input.execServerUrl, ["ws:", "wss:"], "Codex app-server exec bridge must be a loopback websocket");
  assertLoopbackUrl(input.codeModeHostUrl, ["http:"], "Codex code-mode host must be a loopback HTTP tunnel");
  assertRuntimeMatchesBinding(input.runtime, input.scope);
  const token = crypto.randomUUID();
  const key = capabilityKey(token);
  const state: RelaySessionState = {
    scope: structuredClone(input.scope),
    codexHome: input.runtime.codexHome,
    execServerUrl: input.execServerUrl,
    codeModeHostUrl: input.codeModeHostUrl,
    toolGateway: input.toolGateway,
    reusable: input.reusable,
    expiresAt: dependencies.now() + (input.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS),
    connections: 0,
    live: false,
    closed: false,
    run: null,
    turnRuns: new Map(),
    disconnect: null,
  };
  sessions.set(key, state);
  const origin = new URL(input.publicOrigin ?? codexSubscriptionRelayPublicOrigin());
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = `${RELAY_PATH_PREFIX}${token}`;
  origin.search = "";
  origin.hash = "";

  return {
    url: origin.toString(),
    activate(run) {
      if (state.closed) throw new Error("Codex relay session is closed");
      state.run = { ...run, turnStarts: 0 };
    },
    deactivate() {
      state.run = null;
    },
    get connected() {
      return state.live;
    },
    get closed() {
      return state.closed;
    },
    close() {
      closeSession(key, state);
    },
  };
}

/** One run's single-use relay capability: the session dies with its connection. */
export function issueCodexSubscriptionRelayCapability(input: {
  readonly binding: CodexSubscriptionRelayBinding;
  readonly runtime: CodexSubscriptionRuntimeSelection;
  readonly execServerUrl: string;
  readonly codeModeHostUrl: string;
  readonly toolGateway?: ToolGatewayCapabilityDescriptor | null;
  readonly ttlMs?: number;
  readonly publicOrigin?: string;
}): CodexSubscriptionRelayCapability {
  const { runId, model, ...scope } = input.binding;
  const session = openCodexRelaySession({
    scope,
    runtime: input.runtime,
    execServerUrl: input.execServerUrl,
    codeModeHostUrl: input.codeModeHostUrl,
    toolGateway: input.toolGateway ?? null,
    reusable: false,
    ttlMs: input.ttlMs,
    publicOrigin: input.publicOrigin,
  });
  session.activate({ runId, model });
  return { url: session.url, close: () => session.close() };
}

export const codexSubscriptionRelayRoutes = new Hono<AppEnv>();

codexSubscriptionRelayRoutes.get(
  "/:capability",
  upgradeWebSocket((context) => {
    pruneExpiredSessions(dependencies.now());
    const token = context.req.param("capability") ?? "";
    const key = capabilityKey(token);
    const session = sessions.get(key);
    const browserOrigin = context.req.header("origin");
    // A session takes a connection only while it serves a run: between runs
    // the capability opens nothing, not even an app-server on this host.
    const accepted = Boolean(
      session && !session.closed && !browserOrigin && !session.live && session.run &&
        (session.reusable || session.connections === 0) &&
        (session.connections > 0 || session.expiresAt > dependencies.now()),
    );
    // Token-free relay visibility: the capability token is never logged; the runId
    // correlates the sandbox dial with the run. Explains whether the sandbox
    // reached the relay at all and why a capability was refused.
    const runLabel = () => session?.run?.runId ?? "none";
    const validation = accepted
      ? "accepted"
      : !session || session.closed
        ? "unknown-capability"
        : browserOrigin
          ? "rejected-browser-origin"
          : session.live || (!session.reusable && session.connections > 0)
            ? "rejected-consumed"
            : !session.run
              ? "rejected-between-runs"
              : "rejected-expired";
    console.log(`[codex-relay] capability ${validation}${session ? ` run=${runLabel()}` : ""}`);
    if (session && browserOrigin) closeSession(key, session);
    if (session && accepted) {
      session.connections += 1;
      session.live = true;
    }
    let child: ChildProcessWithoutNullStreams | null = null;
    let closed = false;
    const binding = (): CodexSubscriptionRelayBinding => {
      if (!session?.run) throw new Error("no run is active on this relay session");
      return { ...session.scope, runId: session.run.runId, model: session.run.model };
    };
    const protocol = session
      ? new CodexSubscriptionProtocol(binding, {
          loadThreadBinding: () => dependencies.loadThreadBinding(session.scope),
          bindThread: (providerThreadId) => dependencies.bindThread({
            ...session.scope,
            providerThreadId,
          }),
        })
      : null;
    const environmentBootstrap = session
      ? createCodexRemoteEnvironmentBootstrap({
          environmentId: session.scope.environmentId,
          execServerUrl: session.execServerUrl,
        })
      : null;
    const childReady = accepted && session
      ? startCodexSubscriptionAppServer({
          authorize: () => authorizeSession(session),
          isClosed: () => closed,
          spawn: () => dependencies.spawnAppServer({
            codexHome: session.codexHome,
            execServerUrl: session.execServerUrl,
            codeModeHostUrl: session.codeModeHostUrl,
            toolGateway: session.toolGateway,
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
      const reason = errorMessage(error);
      console.log(`[codex-relay] frame rejected run=${runLabel()}: ${reason}`);
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
        if (!session || !accepted) {
          socket.close(1008, "invalid or expired capability");
          return;
        }
        console.log(`[codex-relay] connection open run=${runLabel()}`);
        session.disconnect = () => {
          socket.close(1001, "relay session closed");
          closed = true;
          environmentBootstrap?.close();
          closeChild();
        };
        void attachCodexSubscriptionAppServer({
          childReady,
          isClosed: () => closed,
          closeChild,
          onChildClosed: () => {
            child = null;
          },
          onLine: (line) => serverFrames.enqueue(async () => {
            await authorizeSession(session);
            if (!protocol || !environmentBootstrap) {
              throw new Error("Codex relay protocol is unavailable");
            }
            // The protocol is the account-wide thread boundary. It may hold an
            // out-of-order descendant until ancestry becomes provable, and it
            // never returns foreign thread frames. Sanitize each released frame
            // before any downstream consumer; host image locators exist only in
            // this serial host-side task.
            const ready = await protocol.observeServerFrame(line);
            for (const authorizedFrame of ready) {
              authorizedFrame.commit();
              rememberTurnRun(session, authorizedFrame.raw);
              const prepared = prepareCodexServerFrame(authorizedFrame.raw);
              // Native output belongs to the run whose turn produced it; output
              // of a turn this session did not see start is not attributed.
              const runId = prepared.image ? session.turnRuns.get(prepared.image.turnId) : undefined;
              if (prepared.image && runId) {
                await importCodexNativeOutput({
                  orgId: session.scope.orgId,
                  userId: session.scope.userId,
                  productThreadId: session.scope.threadId,
                  runId,
                  codexHome: session.codexHome,
                  candidate: prepared.image,
                  validateIdentity: (identity) => protocol.validateNativeOutputIdentity(identity),
                });
              }
              const forwarded = await environmentBootstrap.acceptServerFrame(prepared.frame);
              for (const frame of forwarded) socket.send(frame);
            }
          }),
          closeSocket: (code, reason) => socket.close(code, reason),
        });
      },
      onMessage: (event, socket) => {
        relaySocket = socket;
        if (!session || !accepted) return;
        const frame = typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        clientFrames.enqueue(async () => {
          const process = await childReady;
          await authorizeSession(session);
          if (!protocol || !environmentBootstrap) {
            throw new Error("Codex relay protocol is unavailable");
          }
          const local = await protocol.answerLocally(frame);
          if (local) {
            socket.send(local);
            return;
          }
          admitTurnStart(session, frame);
          // The protocol may rewrite the frame (bound-thread `thread/start`
          // becomes `thread/resume`); everything downstream sees the outbound.
          const outbound = await protocol.acceptClientFrame(frame);
          if (!process.stdin.writable) throw new Error("Codex app-server is unavailable");
          const forwarded = await environmentBootstrap.acceptClientFrame(outbound);
          for (const childFrame of forwarded) process.stdin.write(`${childFrame}\n`);
        });
      },
      onClose: () => {
        if (accepted) console.log(`[codex-relay] connection closed run=${runLabel()}`);
        closed = true;
        relaySocket = null;
        environmentBootstrap?.close();
        closeChild();
        if (session && accepted) {
          session.live = false;
          session.disconnect = null;
          if (!session.reusable) closeSession(key, session);
        }
      },
    };
  }),
);

/** Fail closed between runs: a turn starts only while a run is active, and a run
 * starts at most its turn and one continuation. */
function admitTurnStart(session: RelaySessionState, raw: string): void {
  const method = parseCodexSubscriptionFrame(raw, "client").method;
  if (!method || !RUN_BOUND_METHODS.has(method)) return;
  if (!session.run) throw new Error("no run is active on this relay session");
  if (!TURN_STARTING_METHODS.has(method)) return;
  if (session.run.turnStarts >= MAX_TURN_STARTS_PER_RUN) {
    throw new Error("turn start limit for this run reached");
  }
  session.run.turnStarts += 1;
}

/** Remember which run a provider turn started under (bounded, oldest first out). */
function rememberTurnRun(session: RelaySessionState, raw: string): void {
  const frame = parseCodexSubscriptionFrame(raw);
  if (frame.method !== "turn/started" || !session.run) return;
  const turn = frame.params?.turn;
  const turnId = turn && typeof turn === "object" && !Array.isArray(turn)
    ? (turn as Record<string, unknown>).id
    : undefined;
  if (typeof turnId !== "string" || !turnId) return;
  session.turnRuns.set(turnId, session.run.runId);
  if (session.turnRuns.size > MAX_REMEMBERED_TURNS) {
    session.turnRuns.delete(session.turnRuns.keys().next().value!);
  }
}

function closeSession(key: string, session: RelaySessionState): void {
  if (session.closed) return;
  session.closed = true;
  session.run = null;
  sessions.delete(key);
  session.disconnect?.();
  session.disconnect = null;
}

async function authorizeSession(session: RelaySessionState): Promise<void> {
  const runtime = await dependencies.selectRuntime({
    orgId: session.scope.orgId,
    userId: session.scope.userId,
    provider: "openai",
  });
  if (!runtime) throw new Error("Codex subscription is disconnected");
  assertRuntimeMatchesBinding(runtime, session.scope);
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

function threadBindingScope(scope: CodexRelaySessionScope) {
  return {
    orgId: scope.orgId,
    userId: scope.userId,
    productThreadId: scope.threadId,
    connectionId: scope.connectionId,
    authEpoch: scope.authEpoch,
  };
}

function capabilityKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A single-use session nobody dialed in time is gone; reusable ones live until closed. */
function pruneExpiredSessions(now: number): void {
  for (const [key, session] of sessions) {
    if (!session.reusable && session.connections === 0 && session.expiresAt <= now) closeSession(key, session);
  }
}

function assertLoopbackUrl(value: string, protocols: readonly string[], message: string): void {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1")
  ) {
    throw new Error(message);
  }
}

export function setCodexSubscriptionRelayDependenciesForTest(
  overrides: Partial<RelayDependencies> | null,
): void {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
  for (const [key, session] of sessions) closeSession(key, session);
}
