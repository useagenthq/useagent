import {
  sandboxRuntimeLayout,
  type SandboxExecuteResult,
  type SandboxHandle,
  type SandboxRuntimeLayout,
} from "../sandboxes/provider";
import {
  buildRuntimeEnvironmentReadinessCommand,
  ensureRuntimeEnvironment,
  RUNTIME_ENVIRONMENT_HOME,
  RUNTIME_ENVIRONMENT_PORT,
  RUNTIME_GENERATION,
  RUNTIME_ENVIRONMENT_WORKDIR,
  RUNTIME_SANDBOX_HOME,
} from "./runtime-environment";
import {
  buildNativeRuntimeArtifactProbe,
  nativeRuntimeExecutable,
} from "./native-runtime-artifact";
import { ORCHESTRATION_PROTOCOL_HEADER, ORCHESTRATION_PROTOCOL_VERSION } from "./runtime-v2-wire";
import { recordRuntimeArtifactVerified, runtimeArtifactVerified } from "./runtime-artifact-verifications";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

const RUNTIME_AUTH_DIRECTORY = `${RUNTIME_ENVIRONMENT_HOME}/${SANDBOX_NAME_PREFIX}-auth`;
export const RUNTIME_COOKIE_JAR = `${RUNTIME_AUTH_DIRECTORY}/session.cookies`;
const RUNTIME_REQUEST_TIMEOUT_SECONDS = 15;
/** The first shell request builds the runtime's state; the boot script gives it the same budget. */
const RUNTIME_WARMUP_TIMEOUT_SECONDS = 60;
const RUNTIME_HTTP_STATUS_MARKER = "__USEAGENT_T3_HTTP_STATUS__";

export class RuntimeEnvironmentRequestError extends Error {
  readonly status: number | undefined;
  readonly response: Readonly<Record<string, unknown>> | undefined;

  constructor(
    message: string,
    options: {
      readonly status?: number;
      readonly response?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message);
    this.name = "RuntimeEnvironmentRequestError";
    this.status = options.status;
    this.response = options.response;
  }
}

export function isRuntimeEnvironmentMissingSessionError(error: unknown): boolean {
  return error instanceof RuntimeEnvironmentRequestError &&
    (error.status === 404 ||
      (error.response?.code === "not_found" && error.response.reason === "thread_not_found"));
}

/** HTTP carries reads and project mutations only; commands go over the runtime socket. */
export type RuntimeEnvironmentHttpPath =
  | "/api/orchestration/shell"
  | `/api/orchestration/threads/${string}/bounded`
  | "/api/projects/mutate";

/** A read of one thread's recent window (its latest user turns within a byte
 *  budget), with every run, session and request record complete. */
export function runtimeThreadSnapshotRequest(threadId: string): RuntimeEnvironmentRequest {
  return {
    method: "GET",
    path: `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`,
  };
}

interface RuntimeWebSocketTicket {
  readonly ticket: string;
  readonly expiresAt?: string;
}

export interface RuntimeEnvironmentRequest {
  readonly method: "GET" | "POST";
  readonly path: RuntimeEnvironmentHttpPath;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** curl's own budget for this request; the default suits a running runtime. */
  readonly timeoutSeconds?: number;
}

const authenticationOperations = new Map<string | object, Promise<void>>();
const validatedAccess = new Set<string>();
const accessOperations = new Map<string, Promise<void>>();

// The artifact probe is a corruption check, run once per sandbox and runtime
// generation; the record lets a restarted backend skip it as this process would.
const defaultArtifactVerifications = { verified: runtimeArtifactVerified, record: recordRuntimeArtifactVerified };
let artifactVerifications = defaultArtifactVerifications;

export function setRuntimeArtifactVerificationsForTest(store: typeof defaultArtifactVerifications | null): void {
  artifactVerifications = store ?? defaultArtifactVerifications;
}

type RuntimeLoopbackPath =
  | RuntimeEnvironmentHttpPath
  | "/api/auth/session"
  | "/api/auth/browser-session"
  | "/api/auth/websocket-ticket"
  | "/.well-known/t3/environment";

function runtimeLoopbackUrl(path: RuntimeLoopbackPath): string {
  if (
    path !== "/api/auth/session" &&
    path !== "/api/auth/browser-session" &&
    path !== "/api/auth/websocket-ticket" &&
    path !== "/.well-known/t3/environment" &&
    path !== "/api/orchestration/shell" &&
    path !== "/api/projects/mutate" &&
    !/^\/api\/orchestration\/threads\/[a-zA-Z0-9._~%-]+\/bounded$/.test(path)
  ) {
    throw new Error("invalid runtime loopback path");
  }
  return `http://127.0.0.1:${RUNTIME_ENVIRONMENT_PORT}${path}`;
}

function runtimeEnvironmentAccessKey(sandbox: SandboxHandle): string {
  return `${RUNTIME_GENERATION}:${sandbox.id}`;
}

/** Whether this process already talks to the sandbox's runtime (a warm one). */
export function runtimeEnvironmentAccessValidated(sandbox: SandboxHandle): boolean {
  return validatedAccess.has(runtimeEnvironmentAccessKey(sandbox));
}

export function invalidateRuntimeEnvironmentAccess(sandbox: SandboxHandle): void {
  validatedAccess.delete(runtimeEnvironmentAccessKey(sandbox));
}

export function buildRuntimeEnvironmentWebSocketTicketCommand(): string {
  return [
    "set -eu",
    `curl -fsS -m 5 -X POST -b "${RUNTIME_COOKIE_JAR}" -H 'accept: application/json' ${runtimeLoopbackUrl("/api/auth/websocket-ticket")}`,
  ].join("\n");
}

function sessionAssertionPipeline(): string {
  return [
    "node -e",
    `'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const v=JSON.parse(s);if(v.authenticated!==true)process.exit(1)})'`,
  ].join(" ");
}

/** Fails unless the runtime speaks orchestration protocol 2: an older runtime
 *  would accept the plane's reads and refuse its commands, so it is never used. */
export function buildRuntimeEnvironmentProtocolProbeCommand(): string {
  return [
    "set -eu",
    `curl -fsS -m 5 -H 'accept: application/json' ${runtimeLoopbackUrl("/.well-known/t3/environment")} | node -e ${JSON.stringify(
      `let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const v=JSON.parse(s);if(v.orchestrationProtocolVersion!==${ORCHESTRATION_PROTOCOL_VERSION})process.exit(1)})`,
    )}`,
  ].join("\n");
}

export function buildRuntimeEnvironmentSessionProbeCommand(): string {
  return [
    "set -eu",
    `COOKIE="${RUNTIME_COOKIE_JAR}"`,
    'test -s "$COOKIE"',
    `curl -fsS -m 5 -b "$COOKIE" ${runtimeLoopbackUrl("/api/auth/session")} | ${sessionAssertionPipeline()}`,
  ].join("\n");
}

/**
 * Mint and consume a one-time T3 pairing credential inside the sandbox.
 * The credential is redirected to a private temporary file, piped directly to
 * the loopback auth endpoint, and consumed by T3. Only the resulting HttpOnly
 * session cookie remains in the sandbox; neither secret reaches the backend.
 */
export function buildRuntimeEnvironmentAuthenticationCommand(
  layout: SandboxRuntimeLayout = {
    home: RUNTIME_SANDBOX_HOME,
    workdir: RUNTIME_ENVIRONMENT_WORKDIR,
    runsAsRoot: true,
  },
): string {
  const runtimeExecutable = nativeRuntimeExecutable(layout);
  return [
    "set -eu",
    `RUNTIME_HOME="${RUNTIME_ENVIRONMENT_HOME}"`,
    `AUTH_DIR="${RUNTIME_AUTH_DIRECTORY}"`,
    `COOKIE="${RUNTIME_COOKIE_JAR}"`,
    'install -d -m 700 "$AUTH_DIR"',
    `if [ -s "$COOKIE" ] && curl -fsS -m 5 -b "$COOKIE" ${runtimeLoopbackUrl("/api/auth/session")} | ${sessionAssertionPipeline()}; then exit 0; fi`,
    'PAIRING="$(mktemp "$AUTH_DIR/pairing.XXXXXX")"',
    'COOKIE_TMP="$(mktemp "$AUTH_DIR/session.XXXXXX")"',
    'cleanup() { rm -f "$PAIRING" "$COOKIE_TMP"; }',
    "trap cleanup EXIT HUP INT TERM",
    `${JSON.stringify(runtimeExecutable)} auth pairing create --base-dir "$RUNTIME_HOME" --ttl 24h --label ${SANDBOX_NAME_PREFIX}-control-plane --json >"$PAIRING"`,
    [
      `node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({credential:v.credential}))' "$PAIRING"`,
      `curl -fsS -m 10 -c "$COOKIE_TMP" -H 'content-type: application/json' --data-binary @- ${runtimeLoopbackUrl("/api/auth/browser-session")} >/dev/null`,
    ].join(" | "),
    'test -s "$COOKIE_TMP"',
    'chmod 600 "$COOKIE_TMP"',
    'mv "$COOKIE_TMP" "$COOKIE"',
    `curl -fsS -m 5 -b "$COOKIE" ${runtimeLoopbackUrl("/api/auth/session")} | ${sessionAssertionPipeline()}`,
  ].join("\n");
}

export function buildRuntimeEnvironmentRequestCommand(request: RuntimeEnvironmentRequest): string {
  if (request.method === "POST" && request.payload === undefined) {
    throw new Error("the provider runtime POST request requires a payload");
  }
  if (request.method === "GET" && request.payload !== undefined) {
    throw new Error("the provider runtime GET request does not accept a payload");
  }

  const curl = [
    "curl -sS",
    `-m ${request.timeoutSeconds ?? RUNTIME_REQUEST_TIMEOUT_SECONDS}`,
    `-b "${RUNTIME_COOKIE_JAR}"`,
    "-H 'accept: application/json'",
    `-H '${ORCHESTRATION_PROTOCOL_HEADER}: ${ORCHESTRATION_PROTOCOL_VERSION}'`,
    `-w '\n${RUNTIME_HTTP_STATUS_MARKER}:%{http_code}'`,
  ];
  if (request.method === "POST") {
    const payload = Buffer.from(JSON.stringify(request.payload), "utf8").toString("base64");
    return [
      "set -eu",
      `printf %s '${payload}' | base64 -d | ${curl.join(" ")} -H 'content-type: application/json' --data-binary @- '${runtimeLoopbackUrl(request.path)}'`,
    ].join("\n");
  }
  // Quoted: a path is never interpolated bare into the shell.
  return ["set -eu", `${curl.join(" ")} '${runtimeLoopbackUrl(request.path)}'`].join("\n");
}

export function buildRuntimeEnvironmentFirstAccessCommand(
  request: RuntimeEnvironmentRequest,
  layout: SandboxRuntimeLayout = {
    home: RUNTIME_SANDBOX_HOME,
    workdir: RUNTIME_ENVIRONMENT_WORKDIR,
    runsAsRoot: true,
  },
  artifactVerified = false,
): string {
  return [
    "set -eu",
    ...(artifactVerified ? [] : [buildNativeRuntimeArtifactProbe(layout)]),
    buildRuntimeEnvironmentReadinessCommand(),
    buildRuntimeEnvironmentProtocolProbeCommand(),
    buildRuntimeEnvironmentSessionProbeCommand(),
    buildRuntimeEnvironmentRequestCommand(request),
  ].join("\n");
}

async function authenticateRuntimeEnvironment(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error("Provider runtime authentication aborted");
  const key: string | object = sandbox.id || sandbox;
  const previous = authenticationOperations.get(key);
  const operation = (async () => {
    try {
      await previous;
    } catch {
      // A failed predecessor must not poison the sandbox's auth queue.
    }
    const authenticated = await sandbox.process
      .executeCommand(buildRuntimeEnvironmentSessionProbeCommand(), undefined, undefined, 7)
      .catch(() => null);
    if (authenticated?.exitCode === 0) return;
    if (signal.aborted) throw new Error("Provider runtime authentication aborted");
    const layout = sandbox.providerKind
      ? sandboxRuntimeLayout(sandbox.providerKind)
      : {
          home: RUNTIME_SANDBOX_HOME,
          workdir: RUNTIME_ENVIRONMENT_WORKDIR,
          runsAsRoot: true,
        };
    const result = await sandbox.process.executeCommand(
      buildRuntimeEnvironmentAuthenticationCommand(layout),
      undefined,
      undefined,
      30,
    );
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error("Provider runtime authentication failed");
    }
  })();
  authenticationOperations.set(key, operation);
  try {
    await operation;
  } finally {
    if (authenticationOperations.get(key) === operation) {
      authenticationOperations.delete(key);
    }
  }
}

/** Warm only T3's private loopback control session. The one-time pairing
 * credential never leaves the sandbox, and no tenant/provider capability is
 * minted until a real run is assigned. */
export async function prewarmRuntimeEnvironmentAccess(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  await ensureRuntimeEnvironmentAccess(sandbox, signal);
  // The runtime's first shell request builds its state and took fourteen
  // seconds on a fresh sandbox; a pooled sandbox pays it here, not on a run. It
  // gets the boot script's budget and no access repair: a slow build is not a
  // lost session, and a failure here only means a run pays the build itself.
  await executeRuntimeEnvironmentRequest(sandbox, {
    method: "GET",
    path: "/api/orchestration/shell",
    timeoutSeconds: RUNTIME_WARMUP_TIMEOUT_SECONDS,
  }).catch(() => undefined);
}

async function establishRuntimeEnvironmentAccess(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  await ensureRuntimeEnvironment(sandbox, signal);
  await authenticateRuntimeEnvironment(sandbox, signal);
  const protocol = await sandbox.process.executeCommand(
    buildRuntimeEnvironmentProtocolProbeCommand(), undefined, undefined, 7,
  );
  if ((protocol.exitCode ?? 1) !== 0) {
    throw new Error(`The provider runtime does not speak orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}`);
  }
}

async function ensureRuntimeEnvironmentAccess(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  force = false,
): Promise<void> {
  if (signal.aborted) throw new Error("Provider runtime access aborted");
  const key = runtimeEnvironmentAccessKey(sandbox);
  if (!force && validatedAccess.has(key)) return;

  const previous = accessOperations.get(key);
  if (previous && !force) {
    await previous;
    if (validatedAccess.has(key)) return;
  }

  const operation = (async () => {
    try {
      await previous;
    } catch {
      // A failed predecessor must not poison the sandbox's access queue.
    }
    await establishRuntimeEnvironmentAccess(sandbox, signal);
    validatedAccess.add(key);
  })();
  accessOperations.set(key, operation);
  try {
    await operation;
  } finally {
    if (accessOperations.get(key) === operation) {
      accessOperations.delete(key);
    }
  }
}

async function executeRuntimeEnvironmentRequest(
  sandbox: SandboxHandle,
  request: RuntimeEnvironmentRequest,
): Promise<SandboxExecuteResult> {
  return await sandbox.process.executeCommand(
    buildRuntimeEnvironmentRequestCommand(request),
    undefined,
    undefined,
    (request.timeoutSeconds ?? RUNTIME_REQUEST_TIMEOUT_SECONDS) + 2,
  );
}

async function executeRuntimeEnvironmentFirstAccess(
  sandbox: SandboxHandle,
  request: RuntimeEnvironmentRequest,
  signal: AbortSignal,
): Promise<SandboxExecuteResult | null> {
  const key = runtimeEnvironmentAccessKey(sandbox);
  if (validatedAccess.has(key) || accessOperations.has(key)) return null;
  let result: SandboxExecuteResult | null = null;
  const operation = (async () => {
    signal.throwIfAborted();
    const layout = sandbox.providerKind
      ? sandboxRuntimeLayout(sandbox.providerKind)
      : {
          home: RUNTIME_SANDBOX_HOME,
          workdir: RUNTIME_ENVIRONMENT_WORKDIR,
          runsAsRoot: true,
        };
    const artifactVerified = sandbox.id
      ? await artifactVerifications.verified(sandbox.id, RUNTIME_GENERATION).catch(() => false)
      : false;
    try {
      result = await sandbox.process.executeCommand(
        buildRuntimeEnvironmentFirstAccessCommand(request, layout, artifactVerified),
        undefined,
        undefined,
        (request.timeoutSeconds ?? RUNTIME_REQUEST_TIMEOUT_SECONDS) + 2,
      );
      const response = parseRuntimeEnvironmentResponse(result);
      if (
        !runtimeEnvironmentRequestFailed(result, response) ||
        isRuntimeEnvironmentMissingSessionError(runtimeEnvironmentRequestError(request, response))
      ) {
        validatedAccess.add(key);
      }
    } catch {
      // A transport failure takes the same fail-closed repair path as a probe failure.
    }
    if (validatedAccess.has(key)) {
      // The command reached the runtime, so the probe it starts with passed.
      if (!artifactVerified && sandbox.id) {
        await artifactVerifications.record(sandbox.id, RUNTIME_GENERATION).catch((error: unknown) => {
          console.warn("[runtime-environment] the artifact verification was not recorded", { sandboxId: sandbox.id, error });
        });
      }
      return;
    }
    result = null;
    await establishRuntimeEnvironmentAccess(sandbox, signal);
    validatedAccess.add(key);
  })();
  accessOperations.set(key, operation);
  try {
    await operation;
  } finally {
    if (accessOperations.get(key) === operation) accessOperations.delete(key);
  }
  signal.throwIfAborted();
  return result;
}

interface RuntimeEnvironmentResponse {
  readonly body: string;
  readonly status?: number;
}

export function decodeRuntimeEnvironmentCommandOutput(output: string): RuntimeEnvironmentResponse {
  const marker = output.match(new RegExp(`\\n${RUNTIME_HTTP_STATUS_MARKER}:(\\d{3})`));
  if (!marker || marker.index === undefined) return { body: output };
  return {
    body: output.slice(0, marker.index),
    status: Number(marker[1]),
  };
}

function parseRuntimeEnvironmentResponse(result: SandboxExecuteResult): RuntimeEnvironmentResponse {
  return decodeRuntimeEnvironmentCommandOutput(result.result ?? "");
}

function parseRuntimeEnvironmentErrorResponse(
  body: string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the runtime said, so a refusal reads as its reason and not as a bare
 *  status: the orchestration reason plus the cause's detail (`{reason, cause:
 *  {detail}}`), else a message or error field. Bounded; never the whole body. */
export function runtimeEnvironmentErrorDetail(
  body: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!body) return undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const cause = body.cause && typeof body.cause === "object" ? body.cause as Record<string, unknown> : undefined;
  const data = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : undefined;
  const detail = text(cause?.detail) ?? text(cause?.message) ?? text(data?.message) ?? text(body.message) ?? text(body.error);
  const reason = text(body.reason);
  const joined = reason && detail ? `${reason}: ${detail}` : (detail ?? reason);
  return joined === undefined ? undefined : joined.length > 240 ? `${joined.slice(0, 239)}…` : joined;
}

function runtimeEnvironmentRequestError(
  request: RuntimeEnvironmentRequest,
  response: RuntimeEnvironmentResponse,
): RuntimeEnvironmentRequestError {
  const status = response.status;
  const errorResponse = parseRuntimeEnvironmentErrorResponse(response.body);
  const detail = runtimeEnvironmentErrorDetail(errorResponse);
  return new RuntimeEnvironmentRequestError(
    `The provider runtime ${request.method} request failed${status === undefined ? "" : ` (HTTP ${status})`}` +
      (detail ? `: ${detail}` : ""),
    {
      ...(status === undefined ? {} : { status }),
      ...(errorResponse === undefined ? {} : { response: errorResponse }),
    },
  );
}

function runtimeEnvironmentRequestFailed(
  result: SandboxExecuteResult,
  response: RuntimeEnvironmentResponse,
): boolean {
  return (result.exitCode ?? 1) !== 0 || (response.status !== undefined && response.status >= 400);
}

export async function requestRuntimeEnvironment<T>(
  sandbox: SandboxHandle,
  request: RuntimeEnvironmentRequest,
  signal: AbortSignal,
): Promise<T> {
  let result = await executeRuntimeEnvironmentFirstAccess(sandbox, request, signal);
  if (!result) {
    await ensureRuntimeEnvironmentAccess(sandbox, signal);
    if (signal.aborted) throw new Error("Provider runtime request aborted");
    result = await executeRuntimeEnvironmentRequest(sandbox, request);
  }
  let response = parseRuntimeEnvironmentResponse(result);
  if (runtimeEnvironmentRequestFailed(result, response)) {
    const error = runtimeEnvironmentRequestError(request, response);
    if (isRuntimeEnvironmentMissingSessionError(error)) throw error;
    invalidateRuntimeEnvironmentAccess(sandbox);
    await ensureRuntimeEnvironmentAccess(sandbox, signal, true);
    if (signal.aborted) throw new Error("Provider runtime request aborted");
    result = await executeRuntimeEnvironmentRequest(sandbox, request);
    response = parseRuntimeEnvironmentResponse(result);
  }
  if (runtimeEnvironmentRequestFailed(result, response)) {
    throw runtimeEnvironmentRequestError(request, response);
  }
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error("Provider runtime returned invalid JSON");
  }
}

/** Mint a one-time, short-lived websocket ticket for the trusted backend. The
 * ticket exists only in process memory and is consumed on the next T3 socket. */
export async function issueRuntimeEnvironmentWebSocketTicket(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<string> {
  await ensureRuntimeEnvironmentAccess(sandbox, signal);
  if (signal.aborted) throw new Error("the provider runtime websocket ticket request aborted");
  let result = await sandbox.process.executeCommand(
    buildRuntimeEnvironmentWebSocketTicketCommand(),
    undefined,
    undefined,
    7,
  );
  if ((result.exitCode ?? 1) !== 0) {
    invalidateRuntimeEnvironmentAccess(sandbox);
    await ensureRuntimeEnvironmentAccess(sandbox, signal, true);
    if (signal.aborted) throw new Error("the provider runtime websocket ticket request aborted");
    result = await sandbox.process.executeCommand(
      buildRuntimeEnvironmentWebSocketTicketCommand(),
      undefined,
      undefined,
      7,
    );
  }
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("the provider runtime websocket ticket request failed");
  }
  try {
    const response = JSON.parse(result.result ?? "") as RuntimeWebSocketTicket;
    if (typeof response.ticket !== "string" || response.ticket.length < 16) {
      throw new Error("invalid ticket");
    }
    return response.ticket;
  } catch {
    throw new Error("the provider runtime websocket ticket response was invalid");
  }
}
