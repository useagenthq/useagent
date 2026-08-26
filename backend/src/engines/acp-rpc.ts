// Pure, independently-tested ACP relay transport helpers (Section 8 "later
// extraction of independently tested pure transport helpers"). No sandbox, no
// fetch, no Daytona - just the JSON-RPC request bookkeeping and the resident-
// session lifecycle predicate that acp-server.ts's turn loop depends on.
//
// Slice 3 fixes two failure classes here, where they can be tested deterministically:
//   1. disconnect hang - when the relay event pump dies mid-turn, every pending
//      JSON-RPC request must be rejected NOW (stable `relay_disconnected`) instead
//      of hanging until the turn timeout;
//   2. stale session after restart - when the resident agent child restarts, the
//      in-memory native session id is dead and must never receive the next prompt.

import { errorMessage } from "../util/error-message";

export type JsonRpcMessage = Record<string, unknown>;

/** Stable, classified relay error (Section 13 failure codes). `code` is one of the
 *  documented union members (e.g. `relay_disconnected`, `provider_error`); the
 *  message is bounded and never carries credentials or unbounded provider output. */
export class AcpRelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AcpRelayError";
  }
}

export interface AcpRpcClient {
  /** Issue a JSON-RPC request. Resolves with the `result` object, or rejects with
   *  an {@link AcpRelayError} (send failure, an error response, or a pump loss via
   *  {@link failAll}). */
  request(method: string, params: JsonRpcMessage): Promise<JsonRpcMessage>;
  /** Feed a parsed inbound message. If it is a response to a request we are still
   *  awaiting, settle that request and return true; otherwise return false so the
   *  caller can route notifications / server->client requests itself. */
  dispatch(msg: JsonRpcMessage): boolean;
  /** Reject + remove EVERY pending request with a stable code. IDEMPOTENT: a second
   *  call with no pending requests is a no-op. Call exactly when the event pump ends
   *  (EOF / error / abort) so nothing hangs until the turn timeout. */
  failAll(code: string, message: string): void;
  /** Number of requests still awaiting a response (0 after failAll / all settled). */
  readonly pendingCount: number;
}

/** Create a JSON-RPC client over an injected `send` transport (acp-server passes its
 *  relay POST). The client owns ONLY the request/response correlation; the SSE
 *  transport, permission handling, and session/update translation stay in the caller. */
export function createAcpRpcClient(
  send: (msg: JsonRpcMessage) => Promise<void>,
): AcpRpcClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: JsonRpcMessage) => void; reject: (e: Error) => void }>();

  return {
    get pendingCount() {
      return pending.size;
    },

    request(method, params) {
      const id = nextId++;
      const p = new Promise<JsonRpcMessage>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      void send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        const waiter = pending.get(id);
        if (!waiter) return; // already settled (e.g. a race with failAll)
        pending.delete(id);
        waiter.reject(
          e instanceof AcpRelayError
            ? e
            : new AcpRelayError("relay_disconnected", `relay send failed: ${errorMessage(e)}`),
        );
      });
      return p;
    },

    dispatch(msg) {
      const id = msg.id;
      if (typeof id !== "number" || !("result" in msg || "error" in msg)) return false;
      const waiter = pending.get(id);
      if (!waiter) return false;
      pending.delete(id);
      if (msg.error !== undefined && msg.error !== null) {
        waiter.reject(new AcpRelayError("provider_error", `ACP ${JSON.stringify(msg.error).slice(0, 200)}`));
      } else {
        waiter.resolve((msg.result ?? {}) as JsonRpcMessage);
      }
      return true;
    },

    failAll(code, message) {
      if (pending.size === 0) return;
      const waiters = [...pending.values()];
      pending.clear();
      for (const w of waiters) w.reject(new AcpRelayError(code, message));
    },
  };
}

/** The ACP `session/cancel` message (ACP v1 prompt-lifecycle). It is a NOTIFICATION
 *  (no `id`), so it never enters the pending map; the agent stops the ongoing turn and
 *  replies to the in-flight `session/prompt` with stopReason "cancelled". useAgent sends
 *  this on the product abort BEFORE dropping the SSE, so the agent stops NATIVELY
 *  instead of continuing server-side after we disconnect. */
export function buildSessionCancel(sessionId: string): JsonRpcMessage {
  return { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } };
}

/** After (re)booting the resident relay, decide whether the in-memory native session
 *  id is still valid. A relay/agent RESTART (`relayRebooted`) means the previous
 *  process's session no longer exists, so reusing its id would send the next prompt
 *  to a dead session; invalidate it (return null) so the caller falls back to
 *  session/load (persisted id) or session/new. No restart -> keep reusing it. */
export function liveSessionAfterBoot(
  liveSessionId: string | null,
  relayRebooted: boolean,
): string | null {
  return relayRebooted ? null : liveSessionId;
}

/** Per-generation state of a resident ACP relay/agent process: whether it has been
 *  ACP-`initialize`d and its live native session id. Both are valid only for the CURRENT
 *  agent generation. */
export interface RelayGenState {
  readonly initialized: boolean;
  readonly sessionId: string | null;
}

/** Advance the resident relay's per-generation state after a (re)boot. A relay/agent
 *  (RE)START (`relayRebooted`) means a FRESH process: it must be `initialize`d again AND
 *  its previous session id is dead. No restart carries both forward (a reused turn skips
 *  re-initialize and reuses the live session). One source of truth for the whole state
 *  machine so acp-server never re-derives it inline. */
export function relayStateAfterBoot(prev: RelayGenState, relayRebooted: boolean): RelayGenState {
  return relayRebooted
    ? { initialized: false, sessionId: null }
    : { initialized: prev.initialized, sessionId: liveSessionAfterBoot(prev.sessionId, relayRebooted) };
}

/** The relay's `/health` body, distinguishing RELAY liveness from ACP CHILD liveness and
 *  carrying the child GENERATION (bumps each time the ACP child dies + respawns while the
 *  relay HTTP server stays up). */
export interface RelayHealth {
  readonly relay: string;
  readonly generation: number | null;
  readonly childAlive: boolean;
  /** The ACP child has come up and is accepting stdin (a prompt sent before this would be
   *  rejected by the relay `/send` guard). Legacy plain-text health -> assumed ready. */
  readonly childReady: boolean;
}

/** Parse the relay `/health` JSON, tolerant of the legacy plain-text "ok" (generation null).
 *  Pure + total; never throws. */
export function parseRelayHealth(body: string): RelayHealth {
  try {
    const j = JSON.parse(body) as { relay?: unknown; generation?: unknown; childAlive?: unknown; childReady?: unknown };
    return {
      relay: typeof j.relay === "string" ? j.relay : "ok",
      generation: typeof j.generation === "number" ? j.generation : null,
      childAlive: j.childAlive !== false,
      childReady: j.childReady !== false,
    };
  } catch {
    return { relay: body.trim() || "ok", generation: null, childAlive: true, childReady: true };
  }
}

/** Whether the resident ACP CHILD has REGENERATED since we last observed it - i.e. the child
 *  died and respawned (a new generation) even though the relay HTTP server stayed up. Only a
 *  CHANGE from a KNOWN prior generation counts; a first observation (prior null) is not a
 *  regeneration (the fresh-relay path already handles that via `relayRebooted`). Pure. */
export function relayRegenerated(priorGeneration: number | null, currentGeneration: number | null): boolean {
  return priorGeneration != null && currentGeneration != null && currentGeneration !== priorGeneration;
}

/** Whether an ACP error is the "Already initialized" (-32603) a codex-acp agent returns
 *  when `initialize` is re-sent to an already-initialized resident process (e.g. a relay
 *  that survived a backend restart, where our in-memory `initialized` flag was lost).
 *  Treated as success by the caller. */
export function isAlreadyInitialized(err: unknown): boolean {
  return /already initialized/i.test(errorMessage(err));
}
