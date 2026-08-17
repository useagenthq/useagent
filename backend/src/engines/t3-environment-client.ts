import type { SandboxExecuteResult, SandboxHandle } from "../sandboxes/provider";
import {
  ensureT3Environment,
  T3_ENVIRONMENT_HOME,
  T3_ENVIRONMENT_PORT,
  T3_RUNTIME_GENERATION,
} from "./t3-environment";

const T3_AUTH_DIRECTORY = `${T3_ENVIRONMENT_HOME}/skynet-auth`;
const T3_COOKIE_JAR = `${T3_AUTH_DIRECTORY}/session.cookies`;
const T3_REQUEST_TIMEOUT_SECONDS = 15;
const T3_HTTP_STATUS_MARKER = "__SKYNET_T3_HTTP_STATUS__";

export class T3EnvironmentRequestError extends Error {
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
    this.name = "T3EnvironmentRequestError";
    this.status = options.status;
    this.response = options.response;
  }
}

export function isT3EnvironmentMissingSessionError(error: unknown): boolean {
  return error instanceof T3EnvironmentRequestError &&
    (error.status === 404 ||
      (error.response?.code === "not_found" && error.response.reason === "thread_not_found"));
}

export type T3EnvironmentHttpPath =
  | "/api/orchestration/snapshot"
  | "/api/orchestration/shell"
  | `/api/orchestration/threads/${string}`
  | "/api/orchestration/dispatch";

interface T3WebSocketTicket {
  readonly ticket: string;
  readonly expiresAt?: string;
}

export interface T3EnvironmentRequest {
  readonly method: "GET" | "POST";
  readonly path: T3EnvironmentHttpPath;
  readonly payload?: Readonly<Record<string, unknown>>;
}

const authenticationOperations = new Map<string | object, Promise<void>>();
const validatedAccess = new Set<string>();
const accessOperations = new Map<string, Promise<void>>();

type T3LoopbackPath =
  | T3EnvironmentHttpPath
  | "/api/auth/session"
  | "/api/auth/browser-session"
  | "/api/auth/websocket-ticket";

function t3LoopbackUrl(path: T3LoopbackPath): string {
  if (
    path !== "/api/auth/session" &&
    path !== "/api/auth/browser-session" &&
    path !== "/api/auth/websocket-ticket" &&
    path !== "/api/orchestration/snapshot" &&
    path !== "/api/orchestration/shell" &&
    path !== "/api/orchestration/dispatch" &&
    !/^\/api\/orchestration\/threads\/[a-zA-Z0-9._~%-]+$/.test(path)
  ) {
    throw new Error("invalid T3 loopback path");
  }
  return `http://127.0.0.1:${T3_ENVIRONMENT_PORT}${path}`;
}

function t3EnvironmentAccessKey(sandbox: SandboxHandle): string {
  return `${T3_RUNTIME_GENERATION}:${sandbox.id}`;
}

function invalidateT3EnvironmentAccess(sandbox: SandboxHandle): void {
  validatedAccess.delete(t3EnvironmentAccessKey(sandbox));
}

export function buildT3EnvironmentWebSocketTicketCommand(): string {
  return [
    "set -eu",
    `curl -fsS -m 5 -X POST -b "${T3_COOKIE_JAR}" -H 'accept: application/json' ${t3LoopbackUrl("/api/auth/websocket-ticket")}`,
  ].join("\n");
}

function sessionAssertionPipeline(): string {
  return [
    "node -e",
    `'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const v=JSON.parse(s);if(v.authenticated!==true)process.exit(1)})'`,
  ].join(" ");
}

export function buildT3EnvironmentSessionProbeCommand(): string {
  return [
    "set -eu",
    `COOKIE="${T3_COOKIE_JAR}"`,
    'test -s "$COOKIE"',
    `curl -fsS -m 5 -b "$COOKIE" ${t3LoopbackUrl("/api/auth/session")} | ${sessionAssertionPipeline()}`,
  ].join("\n");
}

/**
 * Mint and consume a one-time T3 pairing credential entirely inside the Cube.
 * The credential is redirected to a private temporary file, piped directly to
 * the loopback auth endpoint, and consumed by T3. Only the resulting HttpOnly
 * session cookie remains in the sandbox; neither secret reaches the backend.
 */
export function buildT3EnvironmentAuthenticationCommand(): string {
  return [
    "set -eu",
    `T3_HOME="${T3_ENVIRONMENT_HOME}"`,
    `AUTH_DIR="${T3_AUTH_DIRECTORY}"`,
    `COOKIE="${T3_COOKIE_JAR}"`,
    'install -d -m 700 "$AUTH_DIR"',
    `if [ -s "$COOKIE" ] && curl -fsS -m 5 -b "$COOKIE" ${t3LoopbackUrl("/api/auth/session")} | ${sessionAssertionPipeline()}; then exit 0; fi`,
    'rm -f "$COOKIE"',
    'PAIRING="$(mktemp "$AUTH_DIR/pairing.XXXXXX")"',
    'COOKIE_TMP="$(mktemp "$AUTH_DIR/session.XXXXXX")"',
    'cleanup() { rm -f "$PAIRING" "$COOKIE_TMP"; }',
    "trap cleanup EXIT HUP INT TERM",
    't3 auth pairing create --base-dir "$T3_HOME" --ttl 24h --label skynet-control-plane --json >"$PAIRING"',
    [
      `node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({credential:v.credential}))' "$PAIRING"`,
      `curl -fsS -m 10 -c "$COOKIE_TMP" -H 'content-type: application/json' --data-binary @- ${t3LoopbackUrl("/api/auth/browser-session")} >/dev/null`,
    ].join(" | "),
    'test -s "$COOKIE_TMP"',
    'chmod 600 "$COOKIE_TMP"',
    'mv "$COOKIE_TMP" "$COOKIE"',
    `curl -fsS -m 5 -b "$COOKIE" ${t3LoopbackUrl("/api/auth/session")} | ${sessionAssertionPipeline()}`,
  ].join("\n");
}

export function buildT3EnvironmentRequestCommand(request: T3EnvironmentRequest): string {
  if (request.method === "POST" && request.payload === undefined) {
    throw new Error("T3 POST request requires a payload");
  }
  if (request.method === "GET" && request.payload !== undefined) {
    throw new Error("T3 GET request does not accept a payload");
  }

  const curl = [
    "curl -sS",
    `-m ${T3_REQUEST_TIMEOUT_SECONDS}`,
    `-b "${T3_COOKIE_JAR}"`,
    "-H 'accept: application/json'",
    `-w '\n${T3_HTTP_STATUS_MARKER}:%{http_code}'`,
  ];
  if (request.method === "POST") {
    const payload = Buffer.from(JSON.stringify(request.payload), "utf8").toString("base64");
    return [
      "set -eu",
      `printf %s '${payload}' | base64 -d | ${curl.join(" ")} -H 'content-type: application/json' --data-binary @- ${t3LoopbackUrl(request.path)}`,
    ].join("\n");
  }
  return ["set -eu", `${curl.join(" ")} ${t3LoopbackUrl(request.path)}`].join("\n");
}

async function authenticateT3Environment(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error("T3 environment authentication aborted");
  const key: string | object = sandbox.id || sandbox;
  const previous = authenticationOperations.get(key);
  const operation = (async () => {
    try {
      await previous;
    } catch {
      // A failed predecessor must not poison the sandbox's auth queue.
    }
    const authenticated = await sandbox.process
      .executeCommand(buildT3EnvironmentSessionProbeCommand(), undefined, undefined, 7)
      .catch(() => null);
    if (authenticated?.exitCode === 0) return;
    if (signal.aborted) throw new Error("T3 environment authentication aborted");
    const result = await sandbox.process.executeCommand(
      buildT3EnvironmentAuthenticationCommand(),
      undefined,
      undefined,
      30,
    );
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error("T3 environment authentication failed");
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
export async function prewarmT3EnvironmentAccess(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  await ensureT3EnvironmentAccess(sandbox, signal);
}

async function ensureT3EnvironmentAccess(
  sandbox: SandboxHandle,
  signal: AbortSignal,
  force = false,
): Promise<void> {
  if (signal.aborted) throw new Error("T3 environment access aborted");
  const key = t3EnvironmentAccessKey(sandbox);
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
    await ensureT3Environment(sandbox, signal);
    await authenticateT3Environment(sandbox, signal);
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

async function executeT3EnvironmentRequest(
  sandbox: SandboxHandle,
  request: T3EnvironmentRequest,
): Promise<SandboxExecuteResult> {
  return await sandbox.process.executeCommand(
    buildT3EnvironmentRequestCommand(request),
    undefined,
    undefined,
    T3_REQUEST_TIMEOUT_SECONDS + 2,
  );
}

interface T3EnvironmentResponse {
  readonly body: string;
  readonly status?: number;
}

export function decodeT3EnvironmentCommandOutput(output: string): T3EnvironmentResponse {
  const marker = output.match(new RegExp(`\\n${T3_HTTP_STATUS_MARKER}:(\\d{3})`));
  if (!marker || marker.index === undefined) return { body: output };
  return {
    body: output.slice(0, marker.index),
    status: Number(marker[1]),
  };
}

function parseT3EnvironmentResponse(result: SandboxExecuteResult): T3EnvironmentResponse {
  return decodeT3EnvironmentCommandOutput(result.result ?? "");
}

function parseT3EnvironmentErrorResponse(
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

function t3EnvironmentRequestError(
  request: T3EnvironmentRequest,
  response: T3EnvironmentResponse,
): T3EnvironmentRequestError {
  const status = response.status;
  const errorResponse = parseT3EnvironmentErrorResponse(response.body);
  return new T3EnvironmentRequestError(
    `T3 environment ${request.method} request failed${status === undefined ? "" : ` (HTTP ${status})`}`,
    {
      ...(status === undefined ? {} : { status }),
      ...(errorResponse === undefined ? {} : { response: errorResponse }),
    },
  );
}

function t3EnvironmentRequestFailed(
  result: SandboxExecuteResult,
  response: T3EnvironmentResponse,
): boolean {
  return (result.exitCode ?? 1) !== 0 || (response.status !== undefined && response.status >= 400);
}

export async function requestT3Environment<T>(
  sandbox: SandboxHandle,
  request: T3EnvironmentRequest,
  signal: AbortSignal,
): Promise<T> {
  await ensureT3EnvironmentAccess(sandbox, signal);
  if (signal.aborted) throw new Error("T3 environment request aborted");
  let result = await executeT3EnvironmentRequest(sandbox, request);
  let response = parseT3EnvironmentResponse(result);
  if (t3EnvironmentRequestFailed(result, response)) {
    const error = t3EnvironmentRequestError(request, response);
    if (isT3EnvironmentMissingSessionError(error)) throw error;
    invalidateT3EnvironmentAccess(sandbox);
    await ensureT3EnvironmentAccess(sandbox, signal, true);
    if (signal.aborted) throw new Error("T3 environment request aborted");
    result = await executeT3EnvironmentRequest(sandbox, request);
    response = parseT3EnvironmentResponse(result);
  }
  if (t3EnvironmentRequestFailed(result, response)) {
    throw t3EnvironmentRequestError(request, response);
  }
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error("T3 environment returned invalid JSON");
  }
}

/** Mint a one-time, short-lived websocket ticket for the trusted backend. The
 * ticket exists only in process memory and is consumed on the next T3 socket. */
export async function issueT3EnvironmentWebSocketTicket(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<string> {
  await ensureT3EnvironmentAccess(sandbox, signal);
  if (signal.aborted) throw new Error("T3 websocket ticket request aborted");
  let result = await sandbox.process.executeCommand(
    buildT3EnvironmentWebSocketTicketCommand(),
    undefined,
    undefined,
    7,
  );
  if ((result.exitCode ?? 1) !== 0) {
    invalidateT3EnvironmentAccess(sandbox);
    await ensureT3EnvironmentAccess(sandbox, signal, true);
    if (signal.aborted) throw new Error("T3 websocket ticket request aborted");
    result = await sandbox.process.executeCommand(
      buildT3EnvironmentWebSocketTicketCommand(),
      undefined,
      undefined,
      7,
    );
  }
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("T3 websocket ticket request failed");
  }
  try {
    const response = JSON.parse(result.result ?? "") as T3WebSocketTicket;
    if (typeof response.ticket !== "string" || response.ticket.length < 16) {
      throw new Error("invalid ticket");
    }
    return response.ticket;
  } catch {
    throw new Error("T3 websocket ticket response was invalid");
  }
}
