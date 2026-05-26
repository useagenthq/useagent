import {
  sandboxPreviewHeaders,
  type SandboxHandle,
} from "../sandboxes/provider";
import { RUNTIME_ENVIRONMENT_PORT } from "./runtime-environment";
import { issueRuntimeEnvironmentWebSocketTicket } from "./runtime-environment-client";

const SUBSCRIPTION_REQUEST_ID = 1;
const SUBSCRIPTION_TAG = "orchestration.subscribeThread";

export type RuntimeThreadStreamItem =
  | { readonly kind: "snapshot"; readonly snapshot: unknown }
  | { readonly kind: "event"; readonly event: unknown }
  | { readonly kind: "synchronized" };

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
  afterSequence: number,
): Readonly<Record<string, unknown>> {
  return {
    _tag: "Request",
    id: SUBSCRIPTION_REQUEST_ID,
    tag: SUBSCRIPTION_TAG,
    payload: {
      threadId,
      afterSequence,
      requestCompletionMarker: true,
    },
    headers: [],
  };
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
    const kind = (value as { readonly kind?: unknown }).kind;
    return kind === "snapshot" || kind === "event" || kind === "synchronized";
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

export async function subscribeRuntimeThread(
  sandbox: SandboxHandle,
  threadId: string,
  afterSequence: number,
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
      headers: sandboxPreviewHeaders(preview.token ?? ""),
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
