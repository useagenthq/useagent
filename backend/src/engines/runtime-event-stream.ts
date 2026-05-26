import {
  sandboxPreviewHeaders,
  type SandboxHandle,
} from "../sandboxes/provider";
import { T3_ENVIRONMENT_PORT } from "./runtime-environment";
import { issueT3EnvironmentWebSocketTicket } from "./runtime-environment-client";

const T3_SUBSCRIPTION_REQUEST_ID = 1;
const T3_SUBSCRIPTION_TAG = "orchestration.subscribeThread";

export type T3ThreadStreamItem =
  | { readonly kind: "snapshot"; readonly snapshot: unknown }
  | { readonly kind: "event"; readonly event: unknown }
  | { readonly kind: "synchronized" };

type T3RpcFrame = Readonly<Record<string, unknown>>;

type T3RpcChunk = T3RpcFrame & {
  readonly _tag: "Chunk";
  readonly requestId: string | number;
  readonly values: readonly unknown[];
};

type T3RpcExit = T3RpcFrame & {
  readonly _tag: "Exit";
  readonly requestId: string | number;
  readonly exit: { readonly _tag: "Success" | "Failure" };
};

function isT3RpcChunk(frame: T3RpcFrame): frame is T3RpcChunk {
  return (
    frame._tag === "Chunk" &&
    (typeof frame.requestId === "string" || typeof frame.requestId === "number") &&
    Array.isArray(frame.values)
  );
}

function isT3RpcExit(frame: T3RpcFrame): frame is T3RpcExit {
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

function parseT3RpcFrame(data: string): T3RpcFrame | undefined {
  const parsed = JSON.parse(data) as unknown;
  return parsed && typeof parsed === "object"
    ? parsed as T3RpcFrame
    : undefined;
}

export function buildT3ThreadSubscriptionRequest(
  threadId: string,
  afterSequence: number,
): Readonly<Record<string, unknown>> {
  return {
    _tag: "Request",
    id: T3_SUBSCRIPTION_REQUEST_ID,
    tag: T3_SUBSCRIPTION_TAG,
    payload: {
      threadId,
      afterSequence,
      requestCompletionMarker: true,
    },
    headers: [],
  };
}

export function decodeT3ThreadStreamItems(data: string): readonly T3ThreadStreamItem[] {
  const frame = parseT3RpcFrame(data);
  if (
    !frame ||
    !isT3RpcChunk(frame) ||
    frame.requestId !== T3_SUBSCRIPTION_REQUEST_ID ||
    !frame.values.length
  ) {
    return [];
  }
  return frame.values.filter((value): value is T3ThreadStreamItem => {
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

export async function subscribeT3Thread(
  sandbox: SandboxHandle,
  threadId: string,
  afterSequence: number,
  signal: AbortSignal,
  onItem: (item: T3ThreadStreamItem) => Promise<boolean>,
): Promise<void> {
  const [ticket, preview] = await Promise.all([
    issueT3EnvironmentWebSocketTicket(sandbox, signal),
    sandbox.getPreviewLink(T3_ENVIRONMENT_PORT),
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
          requestId: T3_SUBSCRIPTION_REQUEST_ID,
        }));
      }
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });

    socket.onopen = () => {
      socket.send(
        JSON.stringify(buildT3ThreadSubscriptionRequest(threadId, afterSequence)),
      );
    };
    socket.onmessage = (event) => {
      processing = processing
        .then(async () => {
          const text = await messageText(event.data);
          const frame = parseT3RpcFrame(text);
          if (!frame) return;
          if (
            isT3RpcChunk(frame) &&
            frame.requestId === T3_SUBSCRIPTION_REQUEST_ID
          ) {
            socket.send(JSON.stringify({
              _tag: "Ack",
              requestId: T3_SUBSCRIPTION_REQUEST_ID,
            }));
            for (const item of decodeT3ThreadStreamItems(text)) {
              if (!(await onItem(item))) {
                finish();
                return;
              }
            }
            return;
          }
          if (
            isT3RpcExit(frame) &&
            frame.requestId === T3_SUBSCRIPTION_REQUEST_ID
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
