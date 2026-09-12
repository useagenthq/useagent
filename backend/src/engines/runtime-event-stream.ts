import {
  previewLinkBase,
  type SandboxHandle,
} from "../sandboxes/provider";
import { setTimeout as delay } from "node:timers/promises";
import { RUNTIME_ENVIRONMENT_PORT } from "./runtime-environment";
import { issueRuntimeEnvironmentWebSocketTicket } from "./runtime-environment-client";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

const SUBSCRIPTION_REQUEST_ID = 1;
const SUBSCRIPTION_TAG = "orchestration.subscribeThread";
const STREAM_ERROR_DRAIN_MS = 15_000;

export type RuntimeThreadStreamItem =
  | { readonly kind: "snapshot"; readonly snapshot: RuntimeThreadSnapshot }
  | { readonly kind: "event"; readonly event: RuntimeThreadStreamEvent }
  | { readonly kind: "synchronized" };

export interface RuntimeThreadStreamEvent {
  readonly sequence: number;
  readonly aggregateKind: "thread";
  readonly aggregateId: string;
}

type RuntimeRpcFrame = Readonly<Record<string, unknown>>;

type RuntimeRpcChunk = RuntimeRpcFrame & {
  readonly _tag: "Chunk";
  readonly requestId: string | number;
  readonly values: readonly unknown[];
};

type RuntimeRpcExit = RuntimeRpcFrame & {
  readonly _tag: "Exit";
  readonly requestId: string | number;
  readonly exit: { readonly _tag: "Success" | "Failure" };
};

function isRuntimeRpcChunk(frame: RuntimeRpcFrame): frame is RuntimeRpcChunk {
  return (
    frame._tag === "Chunk" &&
    (typeof frame.requestId === "string" || typeof frame.requestId === "number") &&
    Array.isArray(frame.values)
  );
}

function isRuntimeRpcExit(frame: RuntimeRpcFrame): frame is RuntimeRpcExit {
  if (
    frame._tag !== "Exit" ||
    (typeof frame.requestId !== "string" && typeof frame.requestId !== "number") ||
    !frame.exit ||
    typeof frame.exit !== "object"
  ) {
    return false;
  }
  const tag = (frame.exit as Readonly<Record<string, unknown>>)._tag;
  return tag === "Success" || tag === "Failure";
}

function parseRuntimeRpcFrame(data: string): RuntimeRpcFrame | undefined {
  const parsed = JSON.parse(data) as unknown;
  return parsed && typeof parsed === "object"
    ? parsed as RuntimeRpcFrame
    : undefined;
}

export function buildRuntimeThreadSubscriptionRequest(
  threadId: string,
  afterSequence?: number,
): Readonly<Record<string, unknown>> {
  return {
    _tag: "Request",
    id: SUBSCRIPTION_REQUEST_ID,
    tag: SUBSCRIPTION_TAG,
    payload: {
      threadId,
      ...(afterSequence === undefined ? {} : { afterSequence }),
      requestCompletionMarker: true,
    },
    headers: [],
  };
}

function isRuntimeThreadSnapshot(value: unknown): value is RuntimeThreadSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as {
    readonly snapshotSequence?: unknown;
    readonly thread?: unknown;
  };
  if (!Number.isInteger(snapshot.snapshotSequence) || (snapshot.snapshotSequence as number) < 0) {
    return false;
  }
  if (!snapshot.thread || typeof snapshot.thread !== "object") return false;
  const thread = snapshot.thread as Readonly<Record<string, unknown>>;
  return typeof thread.id === "string" &&
    (thread.latestTurn === null || typeof thread.latestTurn === "object") &&
    Array.isArray(thread.messages) &&
    Array.isArray(thread.activities) &&
    (thread.session === null || typeof thread.session === "object");
}

function isRuntimeThreadStreamEvent(value: unknown): value is RuntimeThreadStreamEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Readonly<Record<string, unknown>>;
  return Number.isInteger(event.sequence) &&
    (event.sequence as number) >= 0 &&
    event.aggregateKind === "thread" &&
    typeof event.aggregateId === "string";
}

export function decodeRuntimeThreadStreamItems(data: string): readonly RuntimeThreadStreamItem[] {
  const frame = parseRuntimeRpcFrame(data);
  if (
    !frame ||
    !isRuntimeRpcChunk(frame) ||
    frame.requestId !== SUBSCRIPTION_REQUEST_ID ||
    !frame.values.length
  ) {
    return [];
  }
  return frame.values.filter((value): value is RuntimeThreadStreamItem => {
    if (!value || typeof value !== "object" || !("kind" in value)) return false;
    const item = value as { readonly kind?: unknown; readonly snapshot?: unknown; readonly event?: unknown };
    return item.kind === "synchronized" ||
      (item.kind === "snapshot" && isRuntimeThreadSnapshot(item.snapshot)) ||
      (item.kind === "event" && isRuntimeThreadStreamEvent(item.event));
  });
}

function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) {
    return Promise.resolve(new TextDecoder().decode(data));
  }
  if (data instanceof Blob) return data.text();
  return Promise.reject(new Error("The provider stream returned an unsupported frame"));
}

export async function followRuntimeThreadSnapshots(input: {
  readonly sandbox: SandboxHandle;
  readonly threadId: string;
  readonly initialSequence: number;
  readonly signal: AbortSignal;
  readonly readSnapshot: (signal: AbortSignal) => Promise<RuntimeThreadSnapshot>;
  readonly applySnapshot: (snapshot: RuntimeThreadSnapshot) => Promise<boolean>;
  readonly subscribe?: typeof subscribeRuntimeThread;
}): Promise<void> {
  let observedSequence = input.initialSequence;
  let refreshThroughSequence = observedSequence;
  let refreshOperation: Promise<void> | null = null;
  let refreshError: unknown;
  let applicationTail: Promise<void> = Promise.resolve();
  let terminalObserved = false;
  const stopped = new AbortController();
  const signal = AbortSignal.any([input.signal, stopped.signal]);
  const apply = (value: unknown): Promise<boolean> => {
    let keepFollowing = true;
    const operation = applicationTail.then(async () => {
      if (signal.aborted) {
        keepFollowing = false;
        return;
      }
      if (!isRuntimeThreadSnapshot(value)) return;
      if (value.thread.id !== input.threadId || value.snapshotSequence <= observedSequence) return;
      observedSequence = value.snapshotSequence;
      keepFollowing = await input.applySnapshot(value);
      if (!keepFollowing) {
        terminalObserved = true;
        stopped.abort();
      }
    });
    applicationTail = operation;
    return operation.then(() => keepFollowing);
  };
  const scheduleRefresh = (sequence: number): void => {
    if (sequence <= observedSequence || signal.aborted) return;
    refreshThroughSequence = Math.max(refreshThroughSequence, sequence);
    if (refreshOperation) return;
    refreshOperation = (async () => {
      try {
        while (!signal.aborted && observedSequence < refreshThroughSequence) {
          const targetSequence = refreshThroughSequence;
          await apply(await input.readSnapshot(signal));
          if (observedSequence < targetSequence && !signal.aborted) {
            await delay(125, undefined, { signal });
          }
        }
      } catch (error) {
        if (!input.signal.aborted && !stopped.signal.aborted) refreshError = error;
        stopped.abort();
      } finally {
        refreshOperation = null;
      }
    })();
  };
  const awaitRefresh = async () => {
    const operation = refreshOperation;
    if (operation) await operation;
  };
  const awaitApplications = async () => {
    await applicationTail;
  };

  let streamError: unknown;
  try {
    await (input.subscribe ?? subscribeRuntimeThread)(
      input.sandbox,
      input.threadId,
      undefined,
      signal,
      async (item) => {
        if (item.kind === "snapshot") return await apply(item.snapshot);
        if (
          item.kind === "event" &&
          item.event.aggregateId === input.threadId &&
          item.event.sequence > observedSequence
        ) {
          scheduleRefresh(item.event.sequence);
        }
        return true;
      },
    );
    await awaitRefresh();
    await awaitApplications();
    stopped.abort();
  } catch (error) {
    streamError = error;
    // A terminal notification can beat its authoritative refresh to a broken
    // socket. Drain work already in flight before classifying the transport
    // failure, bounded independently of the caller's cancellation/deadline.
    await Promise.race([
      awaitRefresh().then(awaitApplications),
      delay(STREAM_ERROR_DRAIN_MS, undefined, { signal }),
    ]).catch(() => {});
    stopped.abort();
  }
  if (refreshError) throw refreshError;
  if (streamError && !terminalObserved) throw streamError;
  if (!terminalObserved && !input.signal.aborted) {
    throw new Error("The provider thread subscription ended before a terminal snapshot");
  }
}

export async function subscribeRuntimeThread(
  sandbox: SandboxHandle,
  threadId: string,
  afterSequence: number | undefined,
  signal: AbortSignal,
  onItem: (item: RuntimeThreadStreamItem) => Promise<boolean>,
): Promise<void> {
  const [ticket, preview] = await Promise.all([
    issueRuntimeEnvironmentWebSocketTicket(sandbox, signal),
    sandbox.getPreviewLink(RUNTIME_ENVIRONMENT_PORT),
  ]);
  const url = new URL(preview.url.replace(/^http/, "ws"));
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let processing = Promise.resolve();
    const socket = new WebSocket(url.toString(), {
      headers: { ...previewLinkBase(preview).headers },
    });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      try {
        socket.close();
      } catch {
        // Socket may not have reached OPEN.
      }
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          _tag: "Interrupt",
          requestId: SUBSCRIPTION_REQUEST_ID,
        }));
      }
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });

    socket.onopen = () => {
      socket.send(
        JSON.stringify(buildRuntimeThreadSubscriptionRequest(threadId, afterSequence)),
      );
    };
    socket.onmessage = (event) => {
      processing = processing
        .then(async () => {
          const text = await messageText(event.data);
          const frame = parseRuntimeRpcFrame(text);
          if (!frame) return;
          if (
            isRuntimeRpcChunk(frame) &&
            frame.requestId === SUBSCRIPTION_REQUEST_ID
          ) {
            socket.send(JSON.stringify({
              _tag: "Ack",
              requestId: SUBSCRIPTION_REQUEST_ID,
            }));
            for (const item of decodeRuntimeThreadStreamItems(text)) {
              if (
                (item.kind === "snapshot" && item.snapshot.thread.id !== threadId) ||
                (item.kind === "event" && item.event.aggregateId !== threadId)
              ) {
                continue;
              }
              if (!(await onItem(item))) {
                finish();
                return;
              }
            }
            return;
          }
          if (
            isRuntimeRpcExit(frame) &&
            frame.requestId === SUBSCRIPTION_REQUEST_ID
          ) {
            finish(
              frame.exit._tag === "Failure"
                ? new Error("The provider thread subscription failed")
                : undefined,
            );
          }
        })
        .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    };
    socket.onerror = () => finish(new Error("The provider stream connection failed"));
    socket.onclose = () => {
      if (!settled) finish(new Error("The provider stream closed before the turn settled"));
    };
    if (signal.aborted) abort();
  });
}
