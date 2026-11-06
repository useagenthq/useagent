import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { openCodexExecServerBridge } from "./codex-exec-server-bridge";

const closeables: Array<{ stop(force?: boolean): void }> = [];

afterEach(() => {
  for (const closeable of closeables.splice(0)) closeable.stop(true);
});

describe("Codex exec-server loopback bridge", () => {
  test("injects provider preview headers without exposing them to the client", async () => {
    const upstream = startHeaderProtectedEchoServer("preview-secret");
    closeables.push(upstream);
    const bridge = openCodexExecServerBridge({
      upstreamUrl: `ws://127.0.0.1:${upstream.port}/exec`,
      expectedUpstreamHost: `127.0.0.1:${upstream.port}`,
      headers: { "x-preview-token": "preview-secret" },
    });
    closeables.push({ stop: () => bridge.close() });

    const socket = new WebSocket(bridge.url);
    const reply = await exchange(socket, "hello");

    expect(reply).toBe("echo:hello");
    expect(bridge.url).toStartWith("ws://127.0.0.1:");
    expect(bridge.url).not.toContain("preview-secret");
  });

  test("rejects an invalid capability path and browser origins", async () => {
    const upstream = startHeaderProtectedEchoServer("preview-secret");
    closeables.push(upstream);
    const bridge = openCodexExecServerBridge({
      upstreamUrl: `ws://127.0.0.1:${upstream.port}/exec`,
      expectedUpstreamHost: `127.0.0.1:${upstream.port}`,
      headers: { "x-preview-token": "preview-secret" },
    });
    closeables.push({ stop: () => bridge.close() });

    const invalid = new URL(bridge.url);
    invalid.pathname = "/forged";
    await expect(webSocketOpened(invalid.toString())).rejects.toThrow();
    const browser = new WebSocket(bridge.url, { headers: { origin: "https://evil.example" } } as never);
    await expect(webSocketOpened(browser)).rejects.toThrow();
  });

  test("takes the app-server back after a dropped link, within its connection bound", async () => {
    // Codex recovers an executor session by dialing the same URL again; a
    // bridge that admitted one connection only turned any drop into a
    // permanent "environment disconnected".
    const upstream = startHeaderProtectedEchoServer("preview-secret");
    closeables.push(upstream);
    const bridge = openCodexExecServerBridge({
      upstreamUrl: `ws://127.0.0.1:${upstream.port}/exec`,
      expectedUpstreamHost: `127.0.0.1:${upstream.port}`,
      headers: { "x-preview-token": "preview-secret" },
    });
    closeables.push({ stop: () => bridge.close() });

    const first = new WebSocket(bridge.url);
    expect(await exchange(first, "one")).toBe("echo:one");
    const firstClosed = webSocketClosed(first);
    first.close();
    await firstClosed;
    const reconnected = new WebSocket(bridge.url);
    expect(await exchange(reconnected, "two")).toBe("echo:two");

    const more = await Promise.all([1, 2, 3].map(() => webSocketOpened(bridge.url)));
    await expect(webSocketOpened(bridge.url)).rejects.toThrow();

    // Closing the bridge ends every connection it holds.
    const ended = [reconnected, ...more].map(webSocketClosed);
    bridge.close();
    expect(await Promise.all(ended)).toHaveLength(4);
  });

  test("rejects a substituted upstream before forwarding preview credentials", () => {
    expect(() => openCodexExecServerBridge({
      upstreamUrl: "wss://attacker.example/exec",
      expectedUpstreamHost: "trusted.preview.example",
      headers: { "x-daytona-preview-token": "preview-secret" },
    })).toThrow("upstream host mismatch");
  });

  test("bounds frames queued while the protected upstream is connecting", async () => {
    const upstream = startHeaderProtectedEchoServer("preview-secret", 100);
    closeables.push(upstream);
    const bridge = openCodexExecServerBridge({
      upstreamUrl: `ws://127.0.0.1:${upstream.port}/exec`,
      expectedUpstreamHost: `127.0.0.1:${upstream.port}`,
      headers: { "x-preview-token": "preview-secret" },
      maxPendingBytes: 4,
    });
    closeables.push({ stop: () => bridge.close() });

    const socket = new WebSocket(bridge.url);
    await webSocketOpened(socket);
    const closed = webSocketClosed(socket);
    socket.send("12345");

    expect(await closed).toBe(1009);
  });
});

function startHeaderProtectedEchoServer(
  token: string,
  handshakeDelayMs = 0,
): Server<{ readonly echo: true }> {
  return Bun.serve<{ readonly echo: true }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (request.headers.get("x-preview-token") !== token) {
        return new Response("unauthorized", { status: 401 });
      }
      if (handshakeDelayMs > 0) await Bun.sleep(handshakeDelayMs);
      return server.upgrade(request, { data: { echo: true } })
        ? undefined
        : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, message) {
        socket.send(`echo:${typeof message === "string" ? message : message.toString()}`);
      },
    },
  });
}

function webSocketClosed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.onclose = (event) => resolve(event.code);
  });
}

function webSocketOpened(socketOrUrl: WebSocket | string): Promise<WebSocket> {
  const socket = typeof socketOrUrl === "string" ? new WebSocket(socketOrUrl) : socketOrUrl;
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("websocket rejected"));
  });
}

async function exchange(socket: WebSocket, message: string): Promise<string> {
  await webSocketOpened(socket);
  return new Promise((resolve, reject) => {
    socket.onmessage = (event) => resolve(String(event.data));
    socket.onerror = () => reject(new Error("websocket exchange failed"));
    socket.send(message);
  });
}
