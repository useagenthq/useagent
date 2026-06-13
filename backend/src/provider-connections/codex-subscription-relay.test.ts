import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import type { AppEnv } from "../http";
import { db } from "../db/client";
import { artifacts, providerEvents } from "../db/schema";
import {
  setTrustedArtifactEventRecorderForTest,
} from "../artifacts/publish";
import { setArtifactStorageForTest } from "../artifacts/storage";
import {
  listFinishedWorkForRun,
  recordFinishedWorkReceipt,
} from "../runs/finished-work-repo";
import { finalizeRun } from "../runs/finalize";
import { resetFinishedWorkSessionLockClientForTest } from "../runs/finished-work-lock";
import { recordProviderEventIfAbsent } from "../runs/provider-events";
import { createRun, getRun } from "../runs/repo";
import { InMemoryArtifactStorage } from "../../test/in-memory-artifact-storage";
import "../../test/helpers";
import type { CodexSubscriptionRuntimeSelection } from "./service";
import {
  importCodexNativeOutput,
  setCodexNativeOutputImportHookForTest,
  setCodexNativeOutputReceiptRecorderForTest,
} from "./codex-native-output-import";
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
const tempRoots: string[] = [];
const previousFinishedWorkRollout = process.env.FINISHED_WORK_ROLLOUT;

afterEach(async () => {
  setCodexSubscriptionRelayDependenciesForTest(null);
  setArtifactStorageForTest(null);
  setTrustedArtifactEventRecorderForTest(null);
  setCodexNativeOutputImportHookForTest(null);
  setCodexNativeOutputReceiptRecorderForTest(null);
  if (previousFinishedWorkRollout === undefined) delete process.env.FINISHED_WORK_ROLLOUT;
  else process.env.FINISHED_WORK_ROLLOUT = previousFinishedWorkRollout;
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await resetFinishedWorkSessionLockClientForTest();
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

    const resume = JSON.stringify({
      id: 20,
      method: "thread/resume",
      params: { threadId: "provider-thread-1", cwd: "/root/work", model: "gpt-5.5" },
    });
    socket.send(resume);
    await eventually(() => expect(child.received).toEqual([resume]));
    const resumeReply = JSON.stringify({
      id: 20,
      result: { thread: { id: "provider-thread-1" } },
    });
    const resumed = collectMessages(socket, 1);
    child.stdout.write(`${resumeReply}\n`);
    expect(await resumed).toEqual([resumeReply]);
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

  test("imports one trusted native image before forwarding a path-free completion", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "shadow";
    const storage = new InMemoryArtifactStorage();
    setArtifactStorageForTest(storage);
    const fixture = await nativeOutputFixture();
    const imagePath = join(fixture.generatedImages, "image.png");
    await writeFile(imagePath, PNG);
    const relay = await initializedNativeOutputRelay(fixture.runId, fixture.codexHome);
    const completion = nativeImageFrame(imagePath);
    const messages = collectMessages(relay.socket, 2);

    relay.child.stdout.write(`${completion}\n${completion}\n`);

    const forwarded = await messages;
    expect(forwarded).toHaveLength(2);
    for (const frame of forwarded) {
      expect(frame).not.toContain(imagePath);
      expect(frame).not.toContain("savedPath");
      expect(frame).not.toContain("result");
      expect(frame).not.toContain("unknownPrivateField");
    }
    const finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations).toHaveLength(1);
    expect(finished.obligations[0]?.state).toBe("satisfied");
    expect(finished.receipts).toHaveLength(1);
    expect(finished.receipts[0]?.metadata).toMatchObject({
      byteCount: PNG.length,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      mime: "image/png",
    });
    const rows = await db.select().from(artifacts).where(eq(artifacts.runId, fixture.runId));
    expect(rows).toHaveLength(1);
    expect(await storage.read(rows[0]!.storageKey)).toEqual(PNG);
    const events = await db.select().from(providerEvents).where(and(
      eq(providerEvents.runId, fixture.runId),
      eq(providerEvents.eventType, "artifact.created"),
    ));
    expect(events).toHaveLength(1);
    expect(JSON.stringify({ finished, rows, events })).not.toContain(fixture.root);
  });

  test("imports a buffered child image before its later turn completion is committed", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "shadow";
    setArtifactStorageForTest(new InMemoryArtifactStorage());
    const fixture = await nativeOutputFixture();
    const imagePath = join(fixture.generatedImages, "child-buffered.png");
    await writeFile(imagePath, PNG);
    const server = startRelayServer();
    const child = fakeAppServer();
    const selected = { ...runtime(), codexHome: fixture.codexHome };
    setCodexSubscriptionRelayDependenciesForTest({
      selectRuntime: async () => selected,
      loadThreadBinding: async () => "provider-thread-1",
      spawnAppServer: () => child.process,
    });
    const capability = issueCodexSubscriptionRelayCapability({
      binding: {
        ...binding(),
        orgId: "org-skynet-dev",
        threadId: fixture.runId,
        runId: fixture.runId,
      },
      runtime: selected,
      execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
      publicOrigin: `http://127.0.0.1:${server.port}`,
    });
    const socket = await opened(capability.url);
    sockets.push(socket);
    await initializeRelay(socket, child, 820);
    const resume = JSON.stringify({
      id: 821,
      method: "thread/resume",
      params: { threadId: "provider-thread-1", cwd: "/root/work", model: "gpt-5.5" },
    });
    socket.send(resume);
    await eventually(() => expect(child.received).toContain(resume));

    const childStarted = JSON.stringify({
      method: "thread/started",
      params: {
        thread: {
          id: "provider-child-1",
          source: {
            subAgent: { thread_spawn: { parent_thread_id: "provider-thread-1" } },
          },
        },
      },
    });
    const turnStarted = JSON.stringify({
      method: "turn/started",
      params: { threadId: "provider-child-1", turn: { id: "child-turn-1" } },
    });
    const image = nativeImageFrame(imagePath, {
      itemId: "child-image-1",
      threadId: "provider-child-1",
      turnId: "child-turn-1",
    });
    const turnCompleted = JSON.stringify({
      method: "turn/completed",
      params: { threadId: "provider-child-1", turn: { id: "child-turn-1" } },
    });
    child.stdout.write(`${childStarted}\n${turnStarted}\n${image}\n${turnCompleted}\n`);
    await Bun.sleep(10);

    const resumeResponse = JSON.stringify({
      id: 821,
      result: { thread: { id: "provider-thread-1" } },
    });
    const messages = collectMessages(socket, 5);
    child.stdout.write(`${resumeResponse}\n`);
    const forwarded = await messages;
    expect(forwarded.slice(0, 3)).toEqual([resumeResponse, childStarted, turnStarted]);
    expect(forwarded[3]).not.toContain(imagePath);
    expect(forwarded[4]).toBe(turnCompleted);

    const finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations).toHaveLength(1);
    expect(finished.obligations[0]?.state).toBe("satisfied");
    expect(finished.receipts).toHaveLength(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  test("bounds 12 image imports whose serialized callbacks open main-pool transactions", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "shadow";
    setArtifactStorageForTest(new InMemoryArtifactStorage());
    const fixture = await nativeOutputFixture();
    const candidates = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const savedPath = join(fixture.generatedImages, `saturation-${index}.png`);
      await writeFile(savedPath, PNG);
      return {
        sourceKey: (index + 1).toString(16).padStart(64, "0"),
        threadId: "provider-thread-1",
        turnId: "turn-1",
        itemId: `saturation-item-${index}`,
        savedPath,
      };
    }));
    setCodexNativeOutputImportHookForTest(async (stage) => {
      if (stage !== "after_obligation") return;
      await db.transaction((tx) => tx.execute(sql`select 1`));
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(candidates.map((candidate) => importCodexNativeOutput({
        orgId: "org-skynet-dev",
        userId: "user-1",
        productThreadId: fixture.runId,
        runId: fixture.runId,
        codexHome: fixture.codexHome,
        candidate,
        validateIdentity: async () => {},
      }))),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Codex image imports exhausted the database pool")), 5_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    const finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations).toHaveLength(12);
    expect(finished.receipts).toHaveLength(12);
    expect(finished.obligations.every((item) => item.state === "satisfied")).toBe(true);
  });

  test("holds finalization across the obligation and artifact receipt gaps", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    setArtifactStorageForTest(new InMemoryArtifactStorage());

    for (const stage of ["after_obligation", "before_receipt"] as const) {
      const fixture = await nativeOutputFixture();
      const imagePath = join(fixture.generatedImages, `${stage}.png`);
      await writeFile(imagePath, PNG);
      const relay = await initializedNativeOutputRelay(fixture.runId, fixture.codexHome);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      setCodexNativeOutputImportHookForTest(async (current) => {
        if (current !== stage) return;
        reached.resolve();
        await release.promise;
      });

      const forwarded = collectMessages(relay.socket, 1);
      relay.child.stdout.write(`${nativeImageFrame(imagePath, { itemId: stage })}\n`);
      await reached.promise;

      const during = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
      expect(during.obligations).toHaveLength(1);
      expect(during.obligations[0]?.state).toBe("open");
      if (stage === "before_receipt") {
        expect(await db.select().from(artifacts).where(eq(artifacts.runId, fixture.runId)))
          .toHaveLength(1);
      }

      let finalized = false;
      const finalization = finalizeRun(fixture.runId, "completed", "generated image", 10)
        .then((result) => {
          finalized = true;
          return result;
        });
      await Bun.sleep(30);
      expect(finalized).toBe(false);
      expect((await getRun(fixture.runId))?.status).not.toBe("completed");

      release.resolve();
      await forwarded;
      expect(await finalization).toMatchObject({ applied: true, status: "completed" });
      expect((await getRun(fixture.runId))?.status).toBe("completed");
      const finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
      expect(finished.obligations[0]?.state).toBe("satisfied");
      expect(finished.receipts).toHaveLength(1);
      setCodexNativeOutputImportHookForTest(null);
    }
  });

  test("keeps event failures retryable and duplicate completion repairs event plus receipt", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    setArtifactStorageForTest(new InMemoryArtifactStorage());
    const fixture = await nativeOutputFixture();
    const imagePath = join(fixture.generatedImages, "event-retry.png");
    await writeFile(imagePath, PNG);
    const relay = await initializedNativeOutputRelay(fixture.runId, fixture.codexHome);
    let first = true;
    setTrustedArtifactEventRecorderForTest(async (input) => {
      if (first) {
        first = false;
        throw new Error("provider event store unavailable");
      }
      return recordProviderEventIfAbsent(input);
    });

    const firstForwarded = collectMessages(relay.socket, 1);
    relay.child.stdout.write(`${nativeImageFrame(imagePath)}\n`);
    expect((await firstForwarded)[0]).not.toContain(imagePath);
    let finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations[0]?.state).toBe("open");
    expect(finished.obligations[0]?.failureCode).toBeNull();
    expect(finished.receipts).toHaveLength(0);
    expect(await db.select().from(artifacts).where(eq(artifacts.runId, fixture.runId)))
      .toHaveLength(1);

    const repaired = collectMessages(relay.socket, 1);
    relay.child.stdout.write(`${nativeImageFrame(imagePath)}\n`);
    expect((await repaired)[0]).not.toContain(imagePath);
    finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations[0]?.state).toBe("satisfied");
    expect(finished.receipts).toHaveLength(1);
    expect(await db.select().from(providerEvents).where(and(
      eq(providerEvents.runId, fixture.runId),
      eq(providerEvents.eventType, "artifact.created"),
    ))).toHaveLength(1);
    expect(relay.child.wasKilled()).toBe(false);
  });

  test("keeps storage failures retryable without disrupting sanitized frame order", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    class FailOnceStorage extends InMemoryArtifactStorage {
      #failed = false;

      override async put(key: string, bytes: Uint8Array): Promise<void> {
        if (!this.#failed) {
          this.#failed = true;
          throw new Error("artifact storage unavailable");
        }
        await super.put(key, bytes);
      }
    }
    setArtifactStorageForTest(new FailOnceStorage());
    const fixture = await nativeOutputFixture();
    const imagePath = join(fixture.generatedImages, "storage-retry.png");
    await writeFile(imagePath, PNG);
    const relay = await initializedNativeOutputRelay(fixture.runId, fixture.codexHome);
    const completion = nativeImageFrame(imagePath);

    const firstForwarded = collectMessages(relay.socket, 1);
    relay.child.stdout.write(`${completion}\n`);
    const [first] = await firstForwarded;
    expect(first).not.toContain(imagePath);
    let finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations[0]?.state).toBe("open");
    expect(finished.receipts).toHaveLength(0);

    const repaired = collectMessages(relay.socket, 1);
    relay.child.stdout.write(`${completion}\n`);
    const [second] = await repaired;
    expect(second).toBe(first);
    finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations[0]?.state).toBe("satisfied");
    expect(finished.receipts).toHaveLength(1);
    expect(relay.child.wasKilled()).toBe(false);
  });

  test("keeps receipt integrity failures open and duplicate completion repairs them", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    setArtifactStorageForTest(new InMemoryArtifactStorage());
    const fixture = await nativeOutputFixture();
    const imagePath = join(fixture.generatedImages, "receipt-retry.png");
    await writeFile(imagePath, PNG);
    const relay = await initializedNativeOutputRelay(fixture.runId, fixture.codexHome);
    let first = true;
    setCodexNativeOutputReceiptRecorderForTest(async (input, exec) => {
      if (first) {
        first = false;
        const integrityError = new Error("receipt integrity failure") as Error & { code: string };
        integrityError.code = "23514";
        throw integrityError;
      }
      return recordFinishedWorkReceipt(input, exec);
    });

    const firstForwarded = collectMessages(relay.socket, 1);
    relay.child.stdout.write(`${nativeImageFrame(imagePath)}\n`);
    await firstForwarded;
    let finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations[0]?.state).toBe("open");
    expect(finished.obligations[0]?.failureCode).toBeNull();
    expect(finished.receipts).toHaveLength(0);

    const repaired = collectMessages(relay.socket, 1);
    relay.child.stdout.write(`${nativeImageFrame(imagePath)}\n`);
    await repaired;
    finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations[0]?.state).toBe("satisfied");
    expect(finished.receipts).toHaveLength(1);
    expect(relay.child.wasKilled()).toBe(false);
  });

  test("forwards sanitized failures without closing and never trusts claimed ids", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "enforce";
    setArtifactStorageForTest(new InMemoryArtifactStorage());
    const fixture = await nativeOutputFixture();
    const outside = join(fixture.root, "outside.png");
    const symlinkPath = join(fixture.generatedImages, "link.png");
    const hardlinkPath = join(fixture.generatedImages, "hardlink.png");
    const invalidMime = join(fixture.generatedImages, "fake.png");
    const missing = join(fixture.generatedImages, "missing.png");
    const oversized = join(fixture.generatedImages, "oversized.png");
    await writeFile(outside, PNG);
    await symlink(outside, symlinkPath);
    await link(outside, hardlinkPath);
    await writeFile(invalidMime, "not an image");
    await Bun.write(oversized, new Uint8Array(50 * 1024 * 1024 + 1));
    const relay = await initializedNativeOutputRelay(fixture.runId, fixture.codexHome);
    const cases = [outside, symlinkPath, hardlinkPath, invalidMime, oversized, missing];
    const messages = collectMessages(relay.socket, cases.length + 1);
    cases.forEach((path, index) => relay.child.stdout.write(`${nativeImageFrame(path, {
      itemId: `image-${index}`,
    })}\n`));
    relay.child.stdout.write(`${nativeImageFrame(outside, {
      itemId: "wrong-thread",
      threadId: "provider-thread-forged",
    })}\n`);
    relay.child.stdout.write(`${nativeImageFrame(outside, {
      itemId: "wrong-turn",
      turnId: "turn-forged",
    })}\n`);

    const forwarded = await messages;
    expect(forwarded).toHaveLength(cases.length + 1);
    expect(forwarded.every((frame) => !frame.includes("wrong-thread"))).toBe(true);
    expect(relay.child.wasKilled()).toBe(false);
    expect(forwarded.every((frame) => !frame.includes(fixture.root) && !frame.includes("savedPath")))
      .toBe(true);
    const finished = await listFinishedWorkForRun("org-skynet-dev", fixture.runId);
    expect(finished.obligations).toHaveLength(cases.length);
    expect(finished.receipts).toHaveLength(0);
    expect(finished.obligations.map((row) => row.failureCode).toSorted()).toEqual([
      "output_content_type_not_allowed",
      "output_hardlink_not_allowed",
      "output_path_outside_root",
      "output_path_unavailable",
      "output_symlink_not_allowed",
      "output_too_large",
    ].toSorted());
    expect(JSON.stringify(finished)).not.toContain(fixture.root);
  });

  test("off mode only sanitizes native output and performs no durable work", async () => {
    process.env.FINISHED_WORK_ROLLOUT = "off";
    setArtifactStorageForTest(new InMemoryArtifactStorage());
    const fixture = await nativeOutputFixture();
    const imagePath = join(fixture.generatedImages, "image.png");
    await writeFile(imagePath, PNG);
    const relay = await initializedNativeOutputRelay(fixture.runId, fixture.codexHome);
    const message = collectMessages(relay.socket, 1);
    relay.child.stdout.write(`${nativeImageFrame(imagePath)}\n`);

    const [forwarded] = await message;
    expect(forwarded).not.toContain(imagePath);
    expect(forwarded).not.toContain("savedPath");
    expect(await listFinishedWorkForRun("org-skynet-dev", fixture.runId)).toEqual({
      obligations: [],
      receipts: [],
    });
    expect(await db.select().from(artifacts).where(eq(artifacts.runId, fixture.runId)))
      .toHaveLength(0);
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

async function nativeOutputFixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "codex-relay-output-"));
  tempRoots.push(root);
  const codexHome = join(root, "codex-home");
  const generatedImages = join(codexHome, "generated_images");
  await mkdir(generatedImages, { recursive: true });
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "generate a native image",
    model: "gpt-5.5",
    engine: "codex",
    orgId: "org-skynet-dev",
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  return { root, codexHome, generatedImages, runId };
}

async function initializedNativeOutputRelay(runId: string, codexHome: string) {
  const server = startRelayServer();
  const child = fakeAppServer();
  const selected = { ...runtime(), codexHome };
  setCodexSubscriptionRelayDependenciesForTest({
    selectRuntime: async () => selected,
    loadThreadBinding: async () => "provider-thread-1",
    spawnAppServer: () => child.process,
  });
  const capability = issueCodexSubscriptionRelayCapability({
    binding: {
      ...binding(),
      orgId: "org-skynet-dev",
      threadId: runId,
      runId,
    },
    runtime: selected,
    execServerUrl: "ws://127.0.0.1:43111/opaque-exec-grant",
    publicOrigin: `http://127.0.0.1:${server.port}`,
  });
  const socket = await opened(capability.url);
  sockets.push(socket);
  await initializeRelay(socket, child, 800);
  const resume = JSON.stringify({
    id: 801,
    method: "thread/resume",
    params: { threadId: "provider-thread-1", cwd: "/root/work", model: "gpt-5.5" },
  });
  socket.send(resume);
  await eventually(() => expect(child.received).toContain(resume));
  const resumeResponse = collectMessages(socket, 1);
  child.stdout.write(`${JSON.stringify({
    id: 801,
    result: { thread: { id: "provider-thread-1" } },
  })}\n`);
  await resumeResponse;
  const turnStarted = collectMessages(socket, 1);
  child.stdout.write(`${JSON.stringify({
    method: "turn/started",
    params: { threadId: "provider-thread-1", turn: { id: "turn-1" } },
  })}\n`);
  await turnStarted;
  return { socket, child };
}

function nativeImageFrame(
  savedPath: string,
  input: { readonly itemId?: string; readonly threadId?: string; readonly turnId?: string } = {},
): string {
  return JSON.stringify({
    method: "item/completed",
    unknownTopLevel: savedPath,
    params: {
      threadId: input.threadId ?? "provider-thread-1",
      turnId: input.turnId ?? "turn-1",
      item: {
        type: "imageGeneration",
        id: input.itemId ?? "image-item-1",
        status: "completed",
        savedPath,
        result: JSON.stringify({ savedPath }),
        unknownPrivateField: savedPath,
      },
    },
  });
}

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
