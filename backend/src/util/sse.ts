/** The one server-sent events response behind every stream the backend serves
 *  (the run, thread, chat and changes streams). It owns the ReadableStream, the
 *  opening comment, the heartbeat, the anti-buffering headers and the teardown
 *  when the connection ends, so a fix here reaches every stream. A route only
 *  writes frames and hands back what to undo when the stream closes. */

/** An idle stream gets a `: ping` comment this often so proxies and browsers
 *  do not drop it. */
export const SSE_HEARTBEAT_MS = 25_000;

/** `no-transform` and `X-Accel-Buffering: no` stop proxies buffering or
 *  rewriting frames; the raw Response is used instead of Hono's streamSSE
 *  because that pins its own Cache-Control and cannot express `no-transform`.
 *  No compression middleware wraps the app (only cors), so nothing buffers
 *  the body. */
export const SSE_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
});

export interface SseStream {
  /** True once the stream has closed; a write after that is dropped. */
  readonly closed: boolean;
  /** Write one raw frame, already terminated (such as `: ping\n\n`). */
  send(frame: string): void;
  /** Write `event: <event>\ndata: <JSON>\n\n`. */
  sendEvent(event: string, data: unknown): void;
  /** End the stream: stop the heartbeat, run the route's teardown once, close
   *  the body. Safe to call more than once. */
  close(): void;
}

export interface SseOptions {
  /** The request's signal: the client leaving closes the stream. */
  signal: AbortSignal;
  /** Sent in the opening comment as `retry: <ms>`, the browser's delay before
   *  it reconnects. */
  retryMs?: number;
  /** How often the heartbeat comment goes out; tests shorten it. */
  heartbeatMs?: number;
}

/**
 * Open a stream, send the opening comment, then hand the route a writer.
 * `start` runs synchronously once, never for a request that is already gone,
 * and may return a teardown that runs exactly once when the stream closes:
 * the client aborting, the body being cancelled, a write failing because the
 * client left, or the route calling `close()`. The last three close the
 * stream on every route now; before this helper only the changes stream
 * closed on a failed write and no route handled a cancelled body.
 */
export function sseResponse(
  options: SseOptions,
  start: (stream: SseStream) => (() => void) | void,
): Response {
  const { signal, retryMs, heartbeatMs = SSE_HEARTBEAT_MS } = options;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let teardown: (() => void) | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    signal.removeEventListener("abort", close);
    const undo = teardown;
    teardown = undefined;
    if (typeof undo === "function") undo();
    try {
      controller?.close();
    } catch {
      /* the body is already closed */
    }
  };
  const send = (frame: string): void => {
    if (closed) return;
    try {
      controller?.enqueue(encoder.encode(frame));
    } catch {
      // The body is closed or errored underneath us: the client is gone, so
      // stop the heartbeat and the route's subscriptions now rather than
      // waiting for the abort.
      close();
    }
  };
  const stream: SseStream = {
    get closed() {
      return closed;
    },
    send,
    sendEvent: (event, data) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    close,
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // Prime the stream so headers and first bytes flush immediately.
      send(retryMs === undefined ? ": open\n\n" : `: open\nretry: ${retryMs}\n\n`);
      heartbeat = setInterval(() => send(": ping\n\n"), heartbeatMs);
      // Never keep the process alive on its own.
      heartbeat.unref?.();
      if (signal.aborted) return close();
      signal.addEventListener("abort", close);
      let undo: (() => void) | void;
      try {
        undo = start(stream);
      } catch (error) {
        // The route failed before it could stream: stop the heartbeat and the
        // abort hook here, then let the request fail as it would have.
        close();
        throw error;
      }
      if (typeof undo !== "function") return;
      // A route may close the stream from inside start; its teardown still runs once.
      if (closed) undo();
      else teardown = undo;
    },
    cancel: close,
  });

  return new Response(body, { headers: SSE_HEADERS });
}
