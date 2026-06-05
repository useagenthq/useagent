import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import type { AppEnv } from "../http";
import type { CodexSubscriptionRuntimeSelection } from "./service";
import {
  codexSubscriptionRelayPublicOrigin,
  codexSubscriptionRelayRoutes,
  issueCodexSubscriptionRelayCapability,
  setCodexSubscriptionRelayDependenciesForTest,
  type CodexSubscriptionRelayBinding,
} from "./codex-subscription-relay";

describe("Codex subscription relay public origin", () => {
  test("uses an explicit relay host without changing the Better Auth origin", () => {
    expect(
      codexSubscriptionRelayPublicOrigin({
        BETTER_AUTH_URL: "https://skynet.meow.gs",
        CODEX_SUBSCRIPTION_RELAY_PUBLIC_ORIGIN: "https://app.useagent.org/path",
      }),
    ).toBe("https://app.useagent.org");
  });

  test("rejects non-HTTP relay origins", () => {
    expect(() =>
      codexSubscriptionRelayPublicOrigin({
        BETTER_AUTH_URL: "https://skynet.meow.gs",
        CODEX_SUBSCRIPTION_RELAY_PUBLIC_ORIGIN: "file:///tmp/socket",
      }),
    ).toThrow("must be an HTTP(S) origin");
  });
});

const servers: Array<{ stop(force?: boolean): void }> = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  setCodexSubscriptionRelayDependenciesForTest(null);
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) server.stop(true);
});

describe("Codex subscription run relay", () => {
  test("registers the private exec bridge after the canonical initialized notification", async () => {
    const server = startRelayServer();
    const child = fakeAppServer();
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => runtime(),
      spawnAppServer: () => child.process,
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const socket = await opened(capability.url);
    sockets.push(socket);
    const initialize = JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "t3", version: "1.0.0" } },
    });
    const initializeResponse = JSON.stringify({
      id: 1,
      result: { userAgent: "codex/0.147.0" },
    });
    const clientResponse = collectMessages(socket, 1);

    socket.send(initialize);
    await eventually(() => expect(child.received).toEqual([initialize]));
    child.stdout.write(`${initializeResponse}\n`);
    expect(await clientResponse).toEqual([initializeResponse]);
    const initialized = JSON.stringify({ method: "initialized" });
    socket.send(initialized);
    await eventually(() => expect(child.received).toHaveLength(3));
    expect(child.received[1]).toBe(initialized);
    const registration = JSON.parse(child.received[2] ?? "") as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    expect(registration).toMatchObject({
      method: "environment/add",
      params: {
        environmentId: "skynet-sandbox-1-run-1",
        execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
        connectTimeoutMs: 15_000,
      },
    });

    child.stdout.write(`${JSON.stringify({ id: registration.id, result: {} })}\n`);
    await Bun.sleep(5);
  });

  test("queues an early frame, reauthorizes it, and preserves native frame ordering", async () => {
    const server = startRelayServer();
    const child = fakeAppServer();
    const authorization = Promise.withResolvers<CodexSubscriptionRuntimeSelection | null>();
    let authorizationCalls = 0;
    let spawnInput: unknown;
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => {
        authorizationCalls += 1;
        if (authorizationCalls === 1) return authorization.promise;
        return runtime();
      },
      loadThreadBinding: async () => "provider-thread-1",
      spawnAppServer: (input) => {
        spawnInput = input;
        return child.process;
      },
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      toolGateway: {
        serverName: "skynet-knowledge",
        url: "https://useagent.example.test/api/internal/tool-gateway",
        bearerToken: "mcp-bearer-secret",
        authorizationHeader: "Bearer mcp-bearer-secret",
        expiresAt: 999_999,
        binding: {
          orgId: "org-1",
          userId: "user-1",
          threadId: "thread-1",
          runId: "run-1",
          scope: "run",
        },
      },
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });

    expect(capability.url).not.toContain("mcp-bearer-secret");
    const socket = await opened(capability.url);
    sockets.push(socket);
    const initialize = JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "t3", version: "1.0.0" } },
    });
    socket.send(initialize);
    await Bun.sleep(5);
    expect(child.received).toEqual([]);

    authorization.resolve(runtime());
    await eventually(() => expect(child.received).toEqual([initialize]));
    expect(authorizationCalls).toBe(2);
    expect(spawnInput).toEqual({
      codexHome: "/host/codex-home",
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      toolGateway: {
        serverName: "skynet-knowledge",
        url: "https://useagent.example.test/api/internal/tool-gateway",
        bearerToken: "mcp-bearer-secret",
        authorizationHeader: "Bearer mcp-bearer-secret",
        expiresAt: 999_999,
        binding: {
          orgId: "org-1",
          userId: "user-1",
          threadId: "thread-1",
          runId: "run-1",
          scope: "run",
        },
      },
    });
    await finishRelayInitialization(socket, child, 1);
    child.received.splice(0);

    const request = JSON.stringify({
      id: 2,
      method: "turn/start",
      params: {
        model: "gpt-5.5",
        threadId: "provider-thread-1",
        environments: [{
          environmentId: "skynet-sandbox-1-run-1",
          cwd: "/root/work",
          runtimeWorkspaceRoots: ["/root/work"],
        }],
      },
    });
    socket.send(request);
    await eventually(() => expect(child.received).toEqual([request]));

    const replies = collectMessages(socket, 2);
    child.stdout.write('{"method":"item/started","params":{"id":"one"}}\n');
    child.stdout.write('{"method":"item/completed","params":{"id":"one"}}\n');
    expect(await replies).toEqual([
      '{"method":"item/started","params":{"id":"one"}}',
      '{"method":"item/completed","params":{"id":"one"}}',
    ]);
  });

  test("makes capabilities one-use and rejects host account methods", async () => {
    const server = startRelayServer();
    const firstChild = fakeAppServer();
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => runtime(),
      spawnAppServer: () => firstChild.process,
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });

    const first = await opened(capability.url);
    sockets.push(first);
    const second = new WebSocket(capability.url);
    const secondClosed = socketClosed(second);
    await opened(second);
    expect(await secondClosed).toMatchObject({ code: 1008 });

    const closed = socketClosed(first);
    first.send(JSON.stringify({ id: 2, method: "Account/Login/Start", params: {} }));
    expect(await closed).toMatchObject({ code: 1008 });
    expect(firstChild.received).toEqual([]);
    expect(firstChild.wasKilled()).toBe(true);
  });

  test("rejects browser origins and unknown future methods", async () => {
    const server = startRelayServer();
    const child = fakeAppServer();
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => runtime(),
      spawnAppServer: () => child.process,
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const browserSocket = new WebSocket(capability.url, {
      headers: { Origin: "https://attacker.example" },
    });
    const browserClosed = socketClosed(browserSocket);
    await opened(browserSocket);
    expect(await browserClosed).toMatchObject({ code: 1008 });

    const secondCapability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const socket = await opened(secondCapability.url);
    sockets.push(socket);
    const closed = socketClosed(socket);
    socket.send(JSON.stringify({ id: 10, method: "future/dangerous", params: {} }));
    expect(await closed).toMatchObject({ code: 1008 });
    expect(child.received).toEqual([]);
  });

  test("allows only correlated responses to app-server requests", async () => {
    const server = startRelayServer();
    const child = fakeAppServer();
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => runtime(),
      spawnAppServer: () => child.process,
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const socket = await opened(capability.url);
    sockets.push(socket);
    await initializeRelay(socket, child, 40);
    const serverRequest = collectMessages(socket, 1);
    child.stdout.write('{"id":44,"method":"item/commandExecution/requestApproval","params":{}}\n');
    expect(await serverRequest).toEqual([
      '{"id":44,"method":"item/commandExecution/requestApproval","params":{}}',
    ]);
    const response = JSON.stringify({ id: 44, result: { decision: "accept" } });
    socket.send(response);
    await eventually(() => expect(child.received).toEqual([response]));

    const closed = socketClosed(socket);
    socket.send(response);
    expect(await closed).toMatchObject({ code: 1008 });
  });

  test("persists thread ownership and accepts only its exact resume cursor", async () => {
    const server = startRelayServer();
    const firstChild = fakeAppServer();
    const resumedChild = fakeAppServer();
    const forgedChild = fakeAppServer();
    const children = [firstChild, resumedChild, forgedChild];
    let storedThreadId: string | null = null;
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => runtime(),
      loadThreadBinding: async () => storedThreadId,
      bindThread: async (input) => {
        storedThreadId = input.providerThreadId;
      },
      spawnAppServer: () => {
        const child = children.shift();
        if (!child) throw new Error("unexpected Codex app-server spawn");
        return child.process;
      },
    });
    const firstCapability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const first = await opened(firstCapability.url);
    sockets.push(first);
    await initializeRelay(first, firstChild, 49);
    first.send(JSON.stringify({
      id: 50,
      method: "thread/start",
      params: { cwd: "/root/work", model: "gpt-5.5" },
    }));
    await eventually(() => expect(firstChild.received).toHaveLength(1));
    firstChild.stdout.write('{"id":50,"result":{"thread":{"id":"provider-thread-1"}}}\n');
    await eventually(() => expect(storedThreadId).toBe("provider-thread-1"));
    first.close();

    const resumeCapability = issueCodexSubscriptionRelayCapability({
      binding: { ...binding(), runId: "run-2" },
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const resumed = await opened(resumeCapability.url);
    sockets.push(resumed);
    await initializeRelay(resumed, resumedChild, 50);
    const resume = JSON.stringify({
      id: 51,
      method: "thread/resume",
      params: {
        threadId: "provider-thread-1",
        cwd: "/root/work",
        model: "gpt-5.5",
      },
    });
    resumed.send(resume);
    await eventually(() => expect(resumedChild.received).toContain(resume));

    const forgedCapability = issueCodexSubscriptionRelayCapability({
      binding: { ...binding(), runId: "run-3" },
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const forged = await opened(forgedCapability.url);
    sockets.push(forged);
    await initializeRelay(forged, forgedChild, 51);
    const forgedClosed = socketClosed(forged);
    forged.send(JSON.stringify({
      id: 52,
      method: "thread/resume",
      params: {
        threadId: "provider-thread-forged",
        cwd: "/root/work",
        model: "gpt-5.5",
      },
    }));
    expect(await forgedClosed).toMatchObject({ code: 1008 });
  });

  test("forwards native thread errors without persisting an unverified cursor", async () => {
    const server = startRelayServer();
    const child = fakeAppServer();
    let storedThreadId: string | null = null;
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => runtime(),
      loadThreadBinding: async () => storedThreadId,
      bindThread: async (input) => {
        storedThreadId = input.providerThreadId;
      },
      spawnAppServer: () => child.process,
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const socket = await opened(capability.url);
    sockets.push(socket);
    await initializeRelay(socket, child, 59);
    socket.send(JSON.stringify({
      id: 60,
      method: "thread/start",
      params: { cwd: "/root/work", model: "gpt-5.5" },
    }));
    await eventually(() => expect(child.received).toHaveLength(1));
    const response = collectMessages(socket, 1);
    child.stdout.write('{"id":60,"error":{"code":-32000,"message":"native failure"}}\n');
    expect(await response).toEqual([
      '{"id":60,"error":{"code":-32000,"message":"native failure"}}',
    ]);
    expect(storedThreadId).toBeNull();
  });

  test("rejects changed authorization and mismatched remote environments", async () => {
    const server = startRelayServer();
    const child = fakeAppServer();
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => runtime(),
      spawnAppServer: () => child.process,
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const socket = await opened(capability.url);
    sockets.push(socket);
    await initializeRelay(socket, child, 2);
    const closed = socketClosed(socket);
    socket.send(JSON.stringify({
      id: 3,
      method: "turn/start",
      params: {
        model: "gpt-5.5",
        threadId: "provider-thread-1",
        environments: [{
          environmentId: "forged",
          cwd: "/root/work",
          runtimeWorkspaceRoots: ["/root/work"],
        }],
      },
    }));

    expect(await closed).toMatchObject({ code: 1008 });
    expect(child.received).toEqual([]);
  });

  test("stops forwarding app-server output immediately after subscription revocation", async () => {
    const server = startRelayServer();
    const child = fakeAppServer();
    let selectedRuntime: CodexSubscriptionRuntimeSelection | null = runtime();
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => selectedRuntime,
      spawnAppServer: () => child.process,
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: binding(),
      runtime: runtime(),
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const socket = await opened(capability.url);
    sockets.push(socket);
    const initialize = JSON.stringify({ id: 71, method: "initialize", params: {} });
    socket.send(initialize);
    await eventually(() => expect(child.received).toEqual([initialize]));

    const closed = socketClosed(socket);
    selectedRuntime = null;
    child.stdout.write('{"method":"item/started","params":{"id":"revoked"}}\n');

    expect(await closed).toMatchObject({ code: 1008 });
    expect(child.wasKilled()).toBe(true);
  });
});

function startRelayServer() {
  const app = new Hono<AppEnv>();
  app.route("/api/internal/codex-relay", codexSubscriptionRelayRoutes);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
    websocket,
  });
  servers.push(server);
  return server;
}

function binding(): CodexSubscriptionRelayBinding {
  return {
    orgId: "org-1",
    userId: "user-1",
    threadId: "thread-1",
    runId: "run-1",
    connectionId: "connection-1",
    authEpoch: "credential-generation-123",
    model: "gpt-5.5",
    sandboxId: "sandbox-1",
    sandboxGeneration: "t3-v2",
    environmentId: "skynet-sandbox-1-run-1",
    cwd: "/root/work",
  };
}

function runtime(): CodexSubscriptionRuntimeSelection {
  return {
    authMethod: "chatgpt_oauth",
    mode: "managed_codex_app_server",
    connectionId: "connection-1",
    authEpoch: "credential-generation-123",
    codexHome: "/host/codex-home",
    metadata: { email: "me@example.test", planType: "pro" },
  };
}

function fakeAppServer() {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received: string[] = [];
  let killed = false;
  let pending = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    received.push(...lines.filter(Boolean));
  });
  const process = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    get killed() {
      return killed;
    },
    kill() {
      killed = true;
      emitter.emit("exit", 0, "SIGTERM");
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  return { process, received, stdout, wasKilled: () => killed };
}

function opened(socketOrUrl: WebSocket | string): Promise<WebSocket> {
  const socket = typeof socketOrUrl === "string" ? new WebSocket(socketOrUrl) : socketOrUrl;
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket rejected")), {
      once: true,
    });
    socket.addEventListener("close", () => reject(new Error("websocket closed before opening")), {
      once: true,
    });
  });
}

function socketClosed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.addEventListener(
      "close",
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    );
  });
}

function collectMessages(socket: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    socket.onmessage = (event) => {
      messages.push(String(event.data));
      if (messages.length === count) resolve(messages);
    };
    socket.onerror = () => reject(new Error("websocket failed while collecting messages"));
  });
}

async function initializeRelay(
  socket: WebSocket,
  child: ReturnType<typeof fakeAppServer>,
  requestId: number,
): Promise<void> {
  const initialize = JSON.stringify({
    id: requestId,
    method: "initialize",
    params: { clientInfo: { name: "t3", version: "1.0.0" } },
  });
  socket.send(initialize);
  await eventually(() => expect(child.received).toContain(initialize));
  await finishRelayInitialization(socket, child, requestId);
  child.received.splice(0);
}

async function finishRelayInitialization(
  socket: WebSocket,
  child: ReturnType<typeof fakeAppServer>,
  requestId: number,
): Promise<void> {
  const initializeResponse = JSON.stringify({
    id: requestId,
    result: { userAgent: "codex/0.147.0" },
  });
  const response = collectMessages(socket, 1);
  child.stdout.write(`${initializeResponse}\n`);
  expect(await response).toEqual([initializeResponse]);
  const initialized = JSON.stringify({ method: "initialized" });
  socket.send(initialized);
  await eventually(() => {
    expect(child.received.some((frame) => {
      const parsed = JSON.parse(frame) as { method?: string };
      return parsed.method === "environment/add";
    })).toBe(true);
  });
  const registrationFrame = child.received.find((frame) => {
    const parsed = JSON.parse(frame) as { method?: string };
    return parsed.method === "environment/add";
  });
  if (!registrationFrame) throw new Error("environment registration frame was not sent");
  const registration = JSON.parse(registrationFrame) as { id: string };
  child.stdout.write(`${JSON.stringify({ id: registration.id, result: {} })}\n`);
  await Bun.sleep(5);
}

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(5);
    }
  }
}
