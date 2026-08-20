import type { SandboxExecuteResult, SandboxHandle } from "../sandboxes/provider";
import {
  ensureRuntimeEnvironment,
  RUNTIME_ENVIRONMENT_HOME,
  RUNTIME_ENVIRONMENT_PORT,
  RUNTIME_GENERATION,
} from "./runtime-environment";

const RUNTIME_AUTH_DIRECTORY = `${RUNTIME_ENVIRONMENT_HOME}/skynet-auth`;
const RUNTIME_COOKIE_JAR = `${RUNTIME_AUTH_DIRECTORY}/session.cookies`;
const RUNTIME_REQUEST_TIMEOUT_SECONDS = 15;
const RUNTIME_HTTP_STATUS_MARKER = "__SKYNET_T3_HTTP_STATUS__";

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

export type RuntimeEnvironmentHttpPath =
  | "/api/orchestration/snapshot"
  | "/api/orchestration/shell"
  | `/api/orchestration/threads/${string}`
  | "/api/orchestration/dispatch";

interface RuntimeWebSocketTicket {
  readonly ticket: string;
  readonly expiresAt?: string;
}

export interface RuntimeEnvironmentRequest {
  readonly method: "GET" | "POST";
  readonly path: RuntimeEnvironmentHttpPath;
  readonly payload?: Readonly<Record<string, unknown>>;
}

const authenticationOperations = new Map<string | object, Promise<void>>();
const validatedAccess = new Set<string>();
const accessOperations = new Map<string, Promise<void>>();

type RuntimeLoopbackPath =
  | RuntimeEnvironmentHttpPath
  | "/api/auth/session"
  | "/api/auth/browser-session"
  | "/api/auth/websocket-ticket";

function runtimeLoopbackUrl(path: RuntimeLoopbackPath): string {
  if (
    path !== "/api/auth/session" &&
    path !== "/api/auth/browser-session" &&
    path !== "/api/auth/websocket-ticket" &&
    path !== "/api/orchestration/snapshot" &&
    path !== "/api/orchestration/shell" &&
    path !== "/api/orchestration/dispatch" &&
    !/^\/api\/orchestration\/threads\/[a-zA-Z0-9._~%-]+$/.test(path)
  ) {
    throw new Error("invalid runtime loopback path");
  }
  return `http://127.0.0.1:${RUNTIME_ENVIRONMENT_PORT}${path}`;
}

function runtimeEnvironmentAccessKey(sandbox: SandboxHandle): string {
  return `${RUNTIME_GENERATION}:${sandbox.id}`;
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

export function buildRuntimeEnvironmentSessionProbeCommand(): string {
  return [
    "set -eu",
    `COOKIE="${RUNTIME_COOKIE_JAR}"`,
    'test -s "$COOKIE"',
    `curl -fsS -m 5 -b "$COOKIE" ${runtimeLoopbackUrl("/api/auth/session")} | ${sessionAssertionPipeline()}`,
  ].join("\n");
}

/**
 * Mint and consume a one-time T3 pairing credential entirely inside the Cube.
 * The credential is redirected to a private temporary file, piped directly to
 * the loopback auth endpoint, and consumed by T3. Only the resulting HttpOnly
 * session cookie remains in the sandbox; neither secret reaches the backend.
 */
export function buildRuntimeEnvironmentAuthenticationCommand(): string {
  return [
    "set -eu",
    `RUNTIME_HOME="${RUNTIME_ENVIRONMENT_HOME}"`,
    `AUTH_DIR="${RUNTIME_AUTH_DIRECTORY}"`,
    `COOKIE="${RUNTIME_COOKIE_JAR}"`,
    'install -d -m 700 "$AUTH_DIR"',
    `if [ -s "$COOKIE" ] && curl -fsS -m 5 -b "$COOKIE" ${runtimeLoopbackUrl("/api/auth/session")} | ${sessionAssertionPipeline()}; then exit 0; fi`,
    'rm -f "$COOKIE"',
    'PAIRING="$(mktemp "$AUTH_DIR/pairing.XXXXXX")"',
    'COOKIE_TMP="$(mktemp "$AUTH_DIR/session.XXXXXX")"',
    'cleanup() { rm -f "$PAIRING" "$COOKIE_TMP"; }',
    "trap cleanup EXIT HUP INT TERM",
    't3 auth pairing create --base-dir "$RUNTIME_HOME" --ttl 24h --label skynet-control-plane --json >"$PAIRING"',
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
    `-m ${RUNTIME_REQUEST_TIMEOUT_SECONDS}`,
    `-b "${RUNTIME_COOKIE_JAR}"`,
    "-H 'accept: application/json'",
    `-w '\n${RUNTIME_HTTP_STATUS_MARKER}:%{http_code}'`,
  ];
  if (request.method === "POST") {
    const payload = Buffer.from(JSON.stringify(request.payload), "utf8").toString("base64");
    return [
      "set -eu",
      `printf %s '${payload}' | base64 -d | ${curl.join(" ")} -H 'content-type: application/json' --data-binary @- ${runtimeLoopbackUrl(request.path)}`,
    ].join("\n");
  }
  return ["set -eu", `${curl.join(" ")} ${runtimeLoopbackUrl(request.path)}`].join("\n");
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
    const result = await sandbox.process.executeCommand(
      buildRuntimeEnvironmentAuthenticationCommand(),
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
    return;
  }

  const operation = (async () => {
    try {
      await previous;
    } catch {
      // A failed predecessor must not poison the sandbox's access queue.
    }
    await ensureRuntimeEnvironment(sandbox, signal);
    await authenticateRuntimeEnvironment(sandbox, signal);
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
    RUNTIME_REQUEST_TIMEOUT_SECONDS + 2,
  );
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

function runtimeEnvironmentRequestError(
  request: RuntimeEnvironmentRequest,
  response: RuntimeEnvironmentResponse,
): RuntimeEnvironmentRequestError {
  const status = response.status;
  const errorResponse = parseRuntimeEnvironmentErrorResponse(response.body);
  return new RuntimeEnvironmentRequestError(
    `The provider runtime ${request.method} request failed${status === undefined ? "" : ` (HTTP ${status})`}`,
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
  await ensureRuntimeEnvironmentAccess(sandbox, signal);
  if (signal.aborted) throw new Error("Provider runtime request aborted");
  let result = await executeRuntimeEnvironmentRequest(sandbox, request);
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
