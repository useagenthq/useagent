import type { Server, ServerWebSocket } from "bun";

interface BridgeSocketData {
  upstream: WebSocket | null;
  pending: Array<string | Uint8Array>;
  pendingBytes: number;
}

const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;
/** Concurrent app-server connections one bridge takes; Codex holds one and briefly a second while it recovers. */
const MAX_CONNECTIONS = 4;

export interface CodexExecServerBridge {
  readonly url: string;
  close(): void;
}

export function openCodexExecServerBridge(input: {
  readonly upstreamUrl: string;
  readonly expectedUpstreamHost: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxPendingBytes?: number;
}): CodexExecServerBridge {
  assertWebSocketUrl(input.upstreamUrl, input.expectedUpstreamHost);
  const maxPendingBytes = input.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
    throw new Error("Codex exec-server bridge pending-byte limit is invalid");
  }
  const capability = crypto.randomUUID();
  const pathname = `/codex-exec/${capability}`;
  const clients = new Set<ServerWebSocket<BridgeSocketData>>();
  let closed = false;

  const server: Server<BridgeSocketData> = Bun.serve<BridgeSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, currentServer) {
      const url = new URL(request.url);
      // The capability admits its session's app-server for the bridge's whole
      // life, not once: after a dropped link Codex dials the same URL again to
      // resume its executor session (a 25 s window). Browsers never get in.
      if (
        closed || url.pathname !== pathname || request.headers.has("origin") ||
        clients.size >= MAX_CONNECTIONS
      ) {
        return new Response("not found", { status: 404 });
      }
      const upgraded = currentServer.upgrade(request, {
        data: { upstream: null, pending: [], pendingBytes: 0 },
      });
      if (upgraded) return undefined;
      return new Response("websocket upgrade required", { status: 426 });
    },
    websocket: {
      open(client) {
        if (closed) {
          client.close(1001, "bridge closed");
          return;
        }
        clients.add(client);
        const upstream = new WebSocket(input.upstreamUrl, { headers: input.headers });
        client.data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.onopen = () => flushPending(client);
        upstream.onmessage = (event) => forwardToClient(client, event.data);
        upstream.onerror = () => client.close(1011, "exec-server upstream failed");
        upstream.onclose = (event) => {
          if (!closed) console.log(`[codex-exec-bridge] exec-server link closed code=${event.code}`);
          client.close(1011, "exec-server upstream closed");
        };
      },
      message(client, message) {
        const payload = typeof message === "string"
          ? message
          : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
        const upstream = client.data.upstream;
        if (!upstream || upstream.readyState !== WebSocket.OPEN) {
          const nextBytes = client.data.pendingBytes + payloadByteLength(payload);
          if (nextBytes > maxPendingBytes) {
            client.close(1009, "exec-server bridge pending frame limit exceeded");
            return;
          }
          client.data.pending.push(payload);
          client.data.pendingBytes = nextBytes;
          return;
        }
        upstream.send(payload);
      },
      close(client) {
        clients.delete(client);
        closeWebSocket(client.data.upstream);
        client.data.upstream = null;
        client.data.pending.length = 0;
        client.data.pendingBytes = 0;
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}${pathname}`,
    close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.close(1001, "bridge closed");
      clients.clear();
      server.stop(true);
    },
  };
}

function flushPending(client: ServerWebSocket<BridgeSocketData>): void {
  const upstream = client.data.upstream;
  if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
  for (const payload of client.data.pending.splice(0)) upstream.send(payload);
  client.data.pendingBytes = 0;
}

function payloadByteLength(payload: string | Uint8Array): number {
  return typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
}

function forwardToClient(
  client: ServerWebSocket<BridgeSocketData>,
  payload: string | ArrayBuffer | Blob,
): void {
  if (typeof payload === "string" || payload instanceof ArrayBuffer) {
    client.send(payload);
    return;
  }
  void forwardBlobToClient(client, payload);
}

async function forwardBlobToClient(
  client: ServerWebSocket<BridgeSocketData>,
  payload: Blob,
): Promise<void> {
  try {
    client.send(await payload.arrayBuffer());
  } catch {
    client.close(1011, "exec-server frame decode failed");
  }
}

function closeWebSocket(socket: WebSocket | null): void {
  if (!socket) return;
  try {
    socket.close(1001, "bridge client closed");
  } catch {
    // Closing an unopened upstream is best-effort during bridge teardown.
  }
}

function assertWebSocketUrl(value: string, expectedHost: string): void {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Codex exec-server bridge requires a websocket URL");
  }
  if (url.host !== expectedHost || url.username || url.password) {
    throw new Error("Codex exec-server bridge upstream host mismatch");
  }
}
