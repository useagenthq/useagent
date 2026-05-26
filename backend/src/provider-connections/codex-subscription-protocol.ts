import type { CodexSubscriptionRelayBinding } from "./codex-subscription-relay";

const CLIENT_METHODS = new Set([
  "initialize",
  "initialized",
  "thread/start",
  "thread/resume",
  "config/mcpServer/reload",
  "mcpServerStatus/list",
  "turn/start",
  "turn/interrupt",
  "thread/read",
  "thread/rollback",
]);

// Sandbox-originated (client) frames stay tightly bounded; frames from OUR
// host-side app-server may carry a full thread-resume history, which grows
// with every turn - a 1MB cap killed real reply turns once a thread
// accumulated large tool outputs ("frame exceeds the relay limit", 2026-08-20).
const MAX_CLIENT_FRAME_BYTES = 1_048_576;
const MAX_SERVER_FRAME_BYTES = 16_777_216;
const MAX_PENDING_REQUESTS = 256;
const textEncoder = new TextEncoder();

type JsonRpcId = string | number;
type JsonObject = Readonly<Record<string, unknown>>;

interface ProtocolDependencies {
  readonly loadThreadBinding: () => Promise<string | null>;
  readonly bindThread: (providerThreadId: string) => Promise<void>;
}

export interface ParsedCodexSubscriptionFrame {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: JsonObject;
  readonly result?: unknown;
  readonly hasError: boolean;
  readonly hasResponse: boolean;
}

export class CodexSubscriptionProtocol {
  readonly #binding: CodexSubscriptionRelayBinding;
  readonly #dependencies: ProtocolDependencies;
  readonly #pendingClientRequests = new Map<JsonRpcId, string>();
  readonly #pendingServerRequests = new Set<JsonRpcId>();
  readonly #knownProviderThreads = new Set<string>();

  constructor(binding: CodexSubscriptionRelayBinding, dependencies: ProtocolDependencies) {
    this.#binding = binding;
    this.#dependencies = dependencies;
  }

  /** Validate a client frame and return the frame to forward upstream. Almost
   *  always the input unchanged; the one rewrite: a `thread/start` for a thread
   *  this run relay has ALREADY bound becomes a `thread/resume` of the bound
   *  provider thread. The T3 driver falls back to `thread/start` whenever its
   *  local resume cursor is missing (per-run relay instances are torn down and
   *  re-patched between turns, so the cursor rarely survives) - honoring the
   *  start verbatim would fork the provider-side conversation, and rejecting it
   *  killed every reply turn ("no first activity", 2026-08-19). Start and
   *  resume share their params shape (resume = start + threadId) and their
   *  response schema, so the rewrite is invisible to the driver. */
  async acceptClientFrame(raw: string): Promise<string> {
    const frame = parseCodexSubscriptionFrame(raw, "client");
    if (!frame.method) {
      if (frame.id === undefined || !frame.hasResponse) {
        throw new Error("client frame must be a request or correlated response");
      }
      if (!this.#pendingServerRequests.delete(frame.id)) {
        throw new Error("uncorrelated app-server response");
      }
      return raw;
    }
    if (!CLIENT_METHODS.has(frame.method)) {
      throw new Error("app-server method is unavailable through the run relay");
    }
    let method = frame.method;
    let outbound = raw;
    if (method === "thread/start") {
      const values = frame.params ?? {};
      assertModelAndCwd(values, this.#binding);
      assertHostOwnedThreadFields(values);
      const bound = await this.#dependencies.loadThreadBinding();
      if (bound) {
        method = "thread/resume";
        const envelope = JSON.parse(raw) as Record<string, unknown>;
        envelope.method = method;
        envelope.params = { ...values, threadId: bound };
        outbound = JSON.stringify(envelope);
        this.#knownProviderThreads.add(bound);
      }
    } else {
      await this.#assertBoundRequest(method, frame.params);
    }
    if (frame.id !== undefined) {
      assertRequestCapacity(this.#pendingClientRequests, frame.id, "client");
      this.#pendingClientRequests.set(frame.id, method);
    }
    return outbound;
  }

  async observeServerFrame(raw: string): Promise<void> {
    const frame = parseCodexSubscriptionFrame(raw);
    if (frame.method) {
      if (frame.id !== undefined) {
        assertRequestCapacity(this.#pendingServerRequests, frame.id, "server");
        this.#pendingServerRequests.add(frame.id);
      }
      this.#rememberNotifiedThread(frame.method, frame.params);
      return;
    }
    if (frame.id === undefined || !frame.hasResponse) return;
    const method = this.#pendingClientRequests.get(frame.id);
    if (!method) return;
    this.#pendingClientRequests.delete(frame.id);
    // App-server errors are part of the native protocol. Forward them unchanged
    // so the driver can apply its documented recovery path; only successful
    // thread responses are allowed to establish or confirm a host binding.
    if (frame.hasError) return;
    if (method !== "thread/start" && method !== "thread/resume") return;
    const providerThreadId = readThreadIdFromResponse(frame.result);
    if (!providerThreadId) throw new Error("Codex thread response omitted its thread id");
    if (method === "thread/start") {
      await this.#dependencies.bindThread(providerThreadId);
    } else {
      const expected = await this.#dependencies.loadThreadBinding();
      if (providerThreadId !== expected) throw new Error("Codex resume response changed thread");
    }
    this.#knownProviderThreads.add(providerThreadId);
  }

  async #assertBoundRequest(method: string, params: JsonObject | undefined): Promise<void> {
    const values = params ?? {};
    switch (method) {
      case "initialize":
      case "initialized":
        return;
      case "config/mcpServer/reload":
        if (params && Object.keys(params).length > 0) {
          throw new Error("Codex MCP reload params are host-owned");
        }
        return;
      // "thread/start" is validated (and rewritten to a resume when the thread
      // is already bound) inline in acceptClientFrame - it never reaches here.
      case "thread/resume": {
        assertModelAndCwd(values, this.#binding);
        assertHostOwnedThreadFields(values);
        const expected = await this.#dependencies.loadThreadBinding();
        if (!expected || values.threadId !== expected) {
          throw new Error("Codex resume thread binding mismatch");
        }
        this.#knownProviderThreads.add(expected);
        return;
      }
      case "turn/start":
        await this.#assertKnownThread(values.threadId);
        if (values.model !== this.#binding.model) throw new Error("model binding mismatch");
        if (values.cwd !== undefined && values.cwd !== this.#binding.cwd) {
          throw new Error("workspace binding mismatch");
        }
        assertTurnEnvironments(values.environments, this.#binding);
        return;
      case "mcpServerStatus/list":
      case "turn/interrupt":
      case "thread/read":
      case "thread/rollback":
        await this.#assertKnownThread(values.threadId);
        return;
    }
  }

  async #assertKnownThread(value: unknown): Promise<void> {
    if (typeof value !== "string") throw new Error("Codex provider thread id is required");
    if (this.#knownProviderThreads.has(value)) return;
    const expected = await this.#dependencies.loadThreadBinding();
    if (!expected || value !== expected) throw new Error("Codex provider thread binding mismatch");
    this.#knownProviderThreads.add(expected);
  }

  #rememberNotifiedThread(method: string, params: JsonObject | undefined): void {
    if (method !== "thread/started") return;
    const thread = params?.thread;
    if (!thread || typeof thread !== "object") return;
    const id = (thread as Record<string, unknown>).id;
    if (typeof id === "string") this.#knownProviderThreads.add(id);
  }
}

export function parseCodexSubscriptionFrame(
  raw: string,
  origin: "client" | "server" = "server",
): ParsedCodexSubscriptionFrame {
  const cap = origin === "client" ? MAX_CLIENT_FRAME_BYTES : MAX_SERVER_FRAME_BYTES;
  if (textEncoder.encode(raw).byteLength > cap) {
    throw new Error("app-server frame exceeds the relay limit");
  }
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid app-server frame");
  }
  const frame = value as Record<string, unknown>;
  const id = frame.id;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    throw new Error("invalid app-server frame id");
  }
  if (frame.method !== undefined && typeof frame.method !== "string") {
    throw new Error("invalid app-server method");
  }
  if (
    frame.params !== undefined &&
    (frame.params === null || typeof frame.params !== "object" || Array.isArray(frame.params))
  ) {
    throw new Error("invalid app-server request params");
  }
  return {
    ...(id !== undefined ? { id } : {}),
    ...(typeof frame.method === "string" ? { method: frame.method } : {}),
    ...(frame.params ? { params: frame.params as JsonObject } : {}),
    ...(Object.hasOwn(frame, "result") ? { result: frame.result } : {}),
    hasError: Object.hasOwn(frame, "error"),
    hasResponse: Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"),
  };
}

function assertRequestCapacity(
  requests: ReadonlyMap<JsonRpcId, unknown> | ReadonlySet<JsonRpcId>,
  id: JsonRpcId,
  direction: "client" | "server",
): void {
  if (requests.has(id)) throw new Error(`duplicate ${direction} request id`);
  if (requests.size >= MAX_PENDING_REQUESTS) {
    throw new Error(`${direction} request limit exceeded`);
  }
}

function assertModelAndCwd(
  params: JsonObject,
  binding: CodexSubscriptionRelayBinding,
): void {
  if (params.model !== binding.model) throw new Error("model binding mismatch");
  if (params.cwd !== binding.cwd) throw new Error("workspace binding mismatch");
}

function assertHostOwnedThreadFields(params: JsonObject): void {
  if (params.config !== undefined && params.config !== null) {
    throw new Error("Codex thread config is host-owned");
  }
  if (params.modelProvider !== undefined && params.modelProvider !== null) {
    throw new Error("Codex model provider is host-owned");
  }
}

function assertTurnEnvironments(
  value: unknown,
  binding: CodexSubscriptionRelayBinding,
): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("exactly one remote execution environment is required");
  }
  const [environment] = value;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("remote execution environment is invalid");
  }
  const fields = environment as Record<string, unknown>;
  if (
    fields.environmentId !== binding.environmentId ||
    fields.cwd !== binding.cwd ||
    !Array.isArray(fields.runtimeWorkspaceRoots) ||
    fields.runtimeWorkspaceRoots.length !== 1 ||
    fields.runtimeWorkspaceRoots[0] !== binding.cwd
  ) {
    throw new Error("remote execution environment binding mismatch");
  }
}

function readThreadIdFromResponse(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return null;
  const id = (thread as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
