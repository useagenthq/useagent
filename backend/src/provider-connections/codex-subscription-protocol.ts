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
const MAX_PENDING_PROVIDER_THREADS = 64;
const MAX_PENDING_SERVER_FRAMES = 256;
const MAX_PENDING_SERVER_BYTES = 1_048_576;
const MAX_OWNED_PROVIDER_THREADS = 256;
const MAX_ACTIVE_TURNS = 256;
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

export interface AuthorizedCodexServerFrame {
  readonly raw: string;
  commit(): void;
}

interface PendingServerFrame {
  readonly raw: string;
  readonly frame: ParsedCodexSubscriptionFrame;
  readonly threadId: string;
  readonly bytes: number;
  readonly order: number;
}

export class CodexSubscriptionProtocol {
  readonly #binding: CodexSubscriptionRelayBinding;
  readonly #dependencies: ProtocolDependencies;
  readonly #pendingClientRequests = new Map<JsonRpcId, {
    readonly method: string;
    readonly expectedThreadId: string | null;
  }>();
  readonly #pendingServerRequests = new Set<JsonRpcId>();
  readonly #knownProviderThreads = new Set<string>();
  readonly #ownedProviderThreadParents = new Map<string, string | null>();
  readonly #pendingProviderThreadParents = new Map<string, string | null>();
  readonly #pendingServerFrames: PendingServerFrame[] = [];
  readonly #activeTurns = new Map<string, string>();
  #pendingServerBytes = 0;
  #nextServerFrameOrder = 0;

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
    let expectedThreadId: string | null = null;
    if (method === "thread/start") {
      const values = frame.params ?? {};
      assertModelAndCwd(values, this.#binding);
      assertHostOwnedThreadFields(values);
      const bound = await this.#dependencies.loadThreadBinding();
      if (bound) {
        method = "thread/resume";
        expectedThreadId = bound;
        const envelope = JSON.parse(raw) as Record<string, unknown>;
        envelope.method = method;
        envelope.params = { ...values, threadId: bound };
        outbound = JSON.stringify(envelope);
      }
    } else {
      await this.#assertBoundRequest(method, frame.params);
      if (method === "thread/resume") {
        expectedThreadId = String(frame.params?.threadId);
      }
    }
    if (frame.id !== undefined) {
      assertRequestCapacity(this.#pendingClientRequests, frame.id, "client");
      this.#pendingClientRequests.set(frame.id, { method, expectedThreadId });
    }
    return outbound;
  }

  /** Validate one host app-server frame and return only frames this relay may
   * forward to T3. Thread-scoped frames whose ancestry is not confirmed are
   * held in a bounded relay-local buffer; foreign frames therefore never cross
   * the account-wide app-server boundary. Confirming an ancestor recursively
   * releases its descendants in original observation order. */
  async observeServerFrame(raw: string): Promise<readonly AuthorizedCodexServerFrame[]> {
    const frame = parseCodexSubscriptionFrame(raw);
    if (frame.method) {
      const registration = readSubagentRegistration(frame);
      let released: readonly AuthorizedCodexServerFrame[] = [];
      if (registration) {
        this.#rememberThreadAncestry(registration.childThreadId, registration.parentThreadId);
        this.#promotePendingDescendants();
        released = this.#flushOwnedServerFrames();
      }
      const threadId = serverFrameThreadId(frame);
      if (frame.method === "thread/started") {
        const started = readStartedThread(frame.params);
        const remembered = this.#rememberThreadAncestry(started.id, started.parentThreadId);
        this.#promotePendingDescendants();
        const ancestryReady = this.#flushOwnedServerFrames();
        if (this.#knownProviderThreads.has(started.id)) {
          return [
            ...released,
            ...ancestryReady,
            this.#authorizedServerFrame(raw, frame),
          ];
        }
        if (remembered) this.#bufferServerFrame(raw, frame, started.id);
        return [...released, ...ancestryReady];
      }
      if (threadId && !this.#knownProviderThreads.has(threadId)) {
        this.#bufferServerFrame(raw, frame, threadId);
        return released;
      }
      return [...released, this.#authorizedServerFrame(raw, frame)];
    }
    if (frame.id === undefined || !frame.hasResponse) return [this.#authorizedServerFrame(raw)];
    const pending = this.#pendingClientRequests.get(frame.id);
    if (!pending) return [this.#authorizedServerFrame(raw)];
    this.#pendingClientRequests.delete(frame.id);
    // App-server errors are part of the native protocol. Forward them unchanged
    // so the driver can apply its documented recovery path; only successful
    // thread responses are allowed to establish or confirm a host binding.
    if (frame.hasError) return [this.#authorizedServerFrame(raw)];
    if (pending.method !== "thread/start" && pending.method !== "thread/resume") {
      return [this.#authorizedServerFrame(raw)];
    }
    const providerThreadId = readThreadIdFromResponse(frame.result);
    if (!providerThreadId) throw new Error("Codex thread response omitted its thread id");
    if (pending.method === "thread/start") {
      const concurrentlyBound = await this.#dependencies.loadThreadBinding();
      if (concurrentlyBound && concurrentlyBound !== providerThreadId) {
        throw new Error("Codex start response changed concurrently bound thread");
      }
      if (!concurrentlyBound) await this.#dependencies.bindThread(providerThreadId);
    } else {
      const expected = pending.expectedThreadId;
      const currentlyBound = await this.#dependencies.loadThreadBinding();
      if (providerThreadId !== expected || providerThreadId !== currentlyBound) {
        throw new Error("Codex resume response changed thread");
      }
    }
    if (
      this.#pendingProviderThreadParents.has(providerThreadId) &&
      this.#pendingProviderThreadParents.get(providerThreadId) !== null
    ) {
      throw new Error("Codex root thread ancestry conflict");
    }
    this.#ownProviderThread(providerThreadId, null);
    this.#pendingProviderThreadParents.delete(providerThreadId);
    this.#promotePendingDescendants();
    return [this.#authorizedServerFrame(raw), ...this.#flushOwnedServerFrames()];
  }

  /** Provider frame ids are only candidates. Accept native output solely when
   * the relay itself established the provider thread and observed the active
   * turn through the native protocol. */
  async validateNativeOutputIdentity(input: {
    readonly threadId: string;
    readonly turnId: string;
  }): Promise<void> {
    if (!this.#knownProviderThreads.has(input.threadId)) {
      throw new Error("Codex native output thread binding mismatch");
    }
    if (this.#activeTurns.get(input.turnId) !== input.threadId) {
      throw new Error("Codex native output turn binding mismatch");
    }
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
        return;
      }
      case "turn/start":
        if (values.model !== this.#binding.model) throw new Error("model binding mismatch");
        if (values.cwd !== undefined && values.cwd !== this.#binding.cwd) {
          throw new Error("workspace binding mismatch");
        }
        assertTurnEnvironments(values.environments, this.#binding);
        await this.#assertKnownThread(values.threadId);
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
    throw new Error("Codex provider thread binding mismatch");
  }

  #rememberThreadAncestry(threadId: string, parentThreadId: string | null): boolean {
    const ownedParent = this.#ownedProviderThreadParents.get(threadId);
    if (this.#knownProviderThreads.has(threadId)) {
      if (ownedParent !== parentThreadId) throw new Error("Codex thread ancestry conflict");
      return true;
    }
    if (parentThreadId && this.#knownProviderThreads.has(parentThreadId)) {
      this.#ownProviderThread(threadId, parentThreadId);
      return true;
    }
    if (this.#pendingProviderThreadParents.has(threadId)) {
      if (this.#pendingProviderThreadParents.get(threadId) !== parentThreadId) {
        throw new Error("Codex thread ancestry conflict");
      }
      return true;
    }
    if (!this.#canTrackPendingThread(threadId)) return false;
    this.#pendingProviderThreadParents.set(threadId, parentThreadId);
    return true;
  }

  #promotePendingDescendants(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [threadId, parentThreadId] of this.#pendingProviderThreadParents) {
        if (!parentThreadId || !this.#knownProviderThreads.has(parentThreadId)) continue;
        this.#ownProviderThread(threadId, parentThreadId);
        this.#pendingProviderThreadParents.delete(threadId);
        changed = true;
      }
    }
  }

  #ownProviderThread(threadId: string, parentThreadId: string | null): void {
    if (!this.#knownProviderThreads.has(threadId)) {
      if (this.#knownProviderThreads.size >= MAX_OWNED_PROVIDER_THREADS) {
        throw new Error("Codex owned provider thread limit exceeded");
      }
      this.#knownProviderThreads.add(threadId);
    }
    this.#ownedProviderThreadParents.set(threadId, parentThreadId);
  }

  #bufferServerFrame(
    raw: string,
    frame: ParsedCodexSubscriptionFrame,
    threadId: string,
  ): boolean {
    if (!this.#canTrackPendingThread(threadId)) return false;
    if (this.#pendingServerFrames.length >= MAX_PENDING_SERVER_FRAMES) {
      return false;
    }
    const bytes = textEncoder.encode(raw).byteLength;
    if (this.#pendingServerBytes + bytes > MAX_PENDING_SERVER_BYTES) {
      return false;
    }
    this.#pendingServerFrames.push({
      raw,
      frame,
      threadId,
      bytes,
      order: this.#nextServerFrameOrder++,
    });
    this.#pendingServerBytes += bytes;
    return true;
  }

  #flushOwnedServerFrames(): readonly AuthorizedCodexServerFrame[] {
    const ready: PendingServerFrame[] = [];
    const held: PendingServerFrame[] = [];
    for (const pending of this.#pendingServerFrames) {
      if (this.#knownProviderThreads.has(pending.threadId)) ready.push(pending);
      else held.push(pending);
    }
    if (ready.length === 0) return [];
    ready.sort((left, right) => left.order - right.order);
    this.#pendingServerFrames.splice(0, this.#pendingServerFrames.length, ...held);
    this.#pendingServerBytes = held.reduce((sum, pending) => sum + pending.bytes, 0);
    return ready.map((pending) => this.#authorizedServerFrame(pending.raw, pending.frame));
  }

  #authorizedServerFrame(
    raw: string,
    frame?: ParsedCodexSubscriptionFrame,
  ): AuthorizedCodexServerFrame {
    let committed = false;
    return {
      raw,
      commit: () => {
        if (committed) return;
        committed = true;
        if (frame) this.#acceptServerMethod(frame);
      },
    };
  }

  #acceptServerMethod(frame: ParsedCodexSubscriptionFrame): void {
    if (frame.id !== undefined) {
      assertRequestCapacity(this.#pendingServerRequests, frame.id, "server");
      this.#pendingServerRequests.add(frame.id);
    }
    if (frame.method) this.#rememberTurn(frame.method, frame.params);
  }

  #canTrackPendingThread(threadId: string): boolean {
    if (
      this.#knownProviderThreads.has(threadId) ||
      this.#pendingProviderThreadParents.has(threadId) ||
      this.#pendingServerFrames.some((pending) => pending.threadId === threadId)
    ) {
      return true;
    }
    const pendingThreadIds = new Set(this.#pendingProviderThreadParents.keys());
    for (const pending of this.#pendingServerFrames) pendingThreadIds.add(pending.threadId);
    return pendingThreadIds.size < MAX_PENDING_PROVIDER_THREADS;
  }

  #rememberTurn(method: string, params: JsonObject | undefined): void {
    if (method !== "turn/started" && method !== "turn/completed" && method !== "turn/failed") {
      return;
    }
    const threadId = params?.threadId;
    if (typeof threadId !== "string" || !this.#knownProviderThreads.has(threadId)) {
      throw new Error("Codex turn lifecycle thread binding mismatch");
    }
    const turn = params?.turn;
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
      throw new Error("Codex turn lifecycle omitted its turn");
    }
    const id = (turn as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("Codex turn lifecycle omitted its turn id");
    }
    if (method === "turn/started") {
      const existing = this.#activeTurns.get(id);
      if (existing && existing !== threadId) {
        throw new Error("Codex turn lifecycle reused a turn across threads");
      }
      if (!existing && this.#activeTurns.size >= MAX_ACTIVE_TURNS) {
        throw new Error("Codex active turn limit exceeded");
      }
      this.#activeTurns.set(id, threadId);
      return;
    }
    if (this.#activeTurns.get(id) !== threadId) {
      throw new Error("Codex turn lifecycle pair mismatch");
    }
    this.#activeTurns.delete(id);
  }

}

function serverFrameThreadId(frame: ParsedCodexSubscriptionFrame): string | null {
  if (frame.method === "thread/started") return readStartedThread(frame.params).id;
  const params = frame.params;
  if (!params) return null;
  const candidates: string[] = [];
  if (Object.hasOwn(params, "threadId")) {
    if (typeof params.threadId !== "string" || params.threadId.length === 0) {
      throw new Error("Codex server frame thread id is invalid");
    }
    candidates.push(params.threadId);
  }
  if (Object.hasOwn(params, "thread")) {
    const thread = objectValue(params.thread);
    if (!thread) throw new Error("Codex server frame thread is invalid");
    if (Object.hasOwn(thread, "id")) {
      if (typeof thread.id !== "string" || thread.id.length === 0) {
        throw new Error("Codex server frame thread id is invalid");
      }
      candidates.push(thread.id);
    }
  }
  const threadIds = new Set(candidates);
  if (threadIds.size > 1) throw new Error("Codex server frame thread binding conflict");
  return candidates[0] ?? null;
}

function readSubagentRegistration(frame: ParsedCodexSubscriptionFrame): {
  readonly childThreadId: string;
  readonly parentThreadId: string;
} | null {
  if (frame.method !== "item/started" && frame.method !== "item/completed") return null;
  const item = objectValue(frame.params?.item);
  if (!item || item.type !== "subAgentActivity" || item.kind !== "started") return null;
  if (typeof item.agentThreadId !== "string" || item.agentThreadId.length === 0) {
    throw new Error("Codex subagent activity omitted its child thread id");
  }
  if (item.agentPath === "/" || item.agentPath === "/root") return null;
  const parentThreadId = serverFrameThreadId(frame);
  if (!parentThreadId || parentThreadId === item.agentThreadId) {
    throw new Error("Codex subagent activity parent binding is invalid");
  }
  return { childThreadId: item.agentThreadId, parentThreadId };
}

function readStartedThread(params: JsonObject | undefined): {
  readonly id: string;
  readonly parentThreadId: string | null;
} {
  const thread = objectValue(params?.thread);
  if (!thread || typeof thread.id !== "string" || thread.id.length === 0) {
    throw new Error("Codex thread lifecycle omitted its thread id");
  }
  return { id: thread.id, parentThreadId: readParentThreadId(thread) };
}

function readParentThreadId(thread: Record<string, unknown>): string | null {
  const source = objectValue(thread.source);
  const subAgent = objectValue(source?.subAgent);
  const spawn = objectValue(subAgent?.thread_spawn) ?? objectValue(subAgent?.threadSpawn);
  const candidates = [
    thread.parentThreadId,
    spawn?.parent_thread_id,
    spawn?.parentThreadId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const parents = new Set(candidates);
  if (parents.size > 1) throw new Error("Codex thread ancestry conflict");
  return candidates[0] ?? null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
