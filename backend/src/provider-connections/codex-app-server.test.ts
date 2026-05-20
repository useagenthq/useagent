import { describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CodexAppServerAuthError,
  CodexAppServerRpcClient,
  ManagedCodexAppServerClientPool,
  type CodexAppServerAccountMethod,
  type CodexChatGptRefreshRequest,
  type CodexChatGptRefreshResponse,
} from "./codex-app-server";
import { createManagedCodexChatGptBroker } from "./codex-app-server-managed";

class FakeAppServerProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  readonly kill = mock(() => true);

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.writes.push(chunk));
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  send(...chunks: string[]): void {
    for (const chunk of chunks) this.stdout.write(chunk);
  }

  messages(): Array<Record<string, unknown>> {
    return this.writes
      .flatMap((write) => write.split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function createClient(
  child: FakeAppServerProcess,
  input: {
    requestTimeoutMs?: number;
    onClose?: () => void;
    onNotification?: (method: string, params: unknown) => void;
    handleChatGptAuthTokensRefresh?: (
      request: CodexChatGptRefreshRequest,
    ) => Promise<CodexChatGptRefreshResponse>;
  } = {},
): CodexAppServerRpcClient {
  return new CodexAppServerRpcClient({
    codexHome: "/tmp/codex-app-server-test",
    onClose: input.onClose ?? (() => undefined),
    onNotification: input.onNotification,
    handleChatGptAuthTokensRefresh: input.handleChatGptAuthTokensRefresh,
    requestTimeoutMs: input.requestTimeoutMs,
    spawnAppServer: () => child.asChild(),
  });
}

async function initialize(child: FakeAppServerProcess): Promise<void> {
  expect(child.messages()[0]).toMatchObject({ id: 1, method: "initialize" });
  child.send('{"id":1,"result":{}}\n');
  await Promise.resolve();
  expect(child.messages()[1]).toEqual({ method: "initialized" });
}

describe("Codex app-server JSON-RPC transport", () => {
  test("rejects forged non-account methods before they reach the child", async () => {
    const child = new FakeAppServerProcess();
    const client = createClient(child);

    await expect(
      client.request("thread/start" as CodexAppServerAccountMethod, undefined),
    ).rejects.toMatchObject({
      name: "CodexAppServerAuthError",
      code: "app_server_rejected",
    } satisfies Partial<CodexAppServerAuthError>);
    expect(child.messages()).toEqual([{ id: 1, method: "initialize", params: expect.any(Object) }]);
    client.close();
  });

  test("buffers split NDJSON frames and correlates interleaved notifications and responses", async () => {
    const child = new FakeAppServerProcess();
    const notifications: Array<{ method: string; params: unknown }> = [];
    const client = createClient(child, {
      onNotification: (method, params) => notifications.push({ method, params }),
    });
    await initialize(child);

    const status = client.request("account/read", { refreshToken: false });
    const logout = client.request("account/logout", undefined);
    await Promise.resolve();
    expect(child.messages().slice(2)).toEqual([
      { id: 2, method: "account/read", params: { refreshToken: false } },
      { id: 3, method: "account/logout" },
    ]);

    child.send(
      '{"id":3,"result":{"status":"logged-out"}}\n{"method":"account/login/com',
      'pleted","params":{"loginId":"login-1","success":true}}\n{"id":2,"res',
      'ult":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":false}}\n',
    );

    await expect(logout).resolves.toEqual({ status: "logged-out" });
    await expect(status).resolves.toEqual({
      account: { type: "chatgpt" },
      requiresOpenaiAuth: false,
    });
    expect(notifications).toEqual([{
      method: "account/login/completed",
      params: { loginId: "login-1", success: true },
    }]);
    client.close();
  });

  test("handles the allowlisted token refresh server request after the initialization handshake", async () => {
    const child = new FakeAppServerProcess();
    const onNotification = mock(() => undefined);
    const handleRefresh = mock(async (request: CodexChatGptRefreshRequest) => ({
      accessToken: "refreshed-access-token",
      chatgptAccountId: request.previousAccountId ?? "account-current",
      chatgptPlanType: "pro",
    }));
    const client = createClient(child, {
      onNotification,
      handleChatGptAuthTokensRefresh: handleRefresh,
    });
    await initialize(child);

    child.send(
      '{"id":"refresh-1","method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized","previousAccountId":"account-1"}}\n',
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(handleRefresh).toHaveBeenCalledWith({
      reason: "unauthorized",
      previousAccountId: "account-1",
    });
    expect(child.messages().at(-1)).toEqual({
      id: "refresh-1",
      result: {
        accessToken: "refreshed-access-token",
        chatgptAccountId: "account-1",
        chatgptPlanType: "pro",
      },
    });
    expect(onNotification).not.toHaveBeenCalled();
    client.close();
  });

  test("strictly validates refresh params before calling the trusted handler", async () => {
    const invalidParams = [
      undefined,
      null,
      [],
      {},
      { reason: "expired" },
      { reason: "unauthorized", previousAccountId: 123 },
      { reason: "unauthorized", extra: "secret-payload" },
    ];

    for (const [index, params] of invalidParams.entries()) {
      const child = new FakeAppServerProcess();
      const handleRefresh = mock(async () => ({
        accessToken: "must-not-be-returned",
        chatgptAccountId: "must-not-be-returned",
        chatgptPlanType: null,
      }));
      const client = createClient(child, { handleChatGptAuthTokensRefresh: handleRefresh });
      await initialize(child);

      child.send(`${JSON.stringify({
        id: `invalid-${index}`,
        method: "account/chatgptAuthTokens/refresh",
        params,
      })}\n`);
      await Promise.resolve();

      expect(handleRefresh).not.toHaveBeenCalled();
      expect(child.messages().at(-1)).toEqual({
        id: `invalid-${index}`,
        error: {
          code: -32602,
          message: "invalid token refresh params",
        },
      });
      client.close();
    }
  });

  test("sanitizes refresh-handler failures and unsupported server requests", async () => {
    const child = new FakeAppServerProcess();
    const secret = "scope-and-token-must-not-leak";
    const client = createClient(child, {
      handleChatGptAuthTokensRefresh: async () => {
        throw new Error(secret);
      },
    });
    await initialize(child);

    child.send(
      `{\"id\":\"refresh-failed\",\"method\":\"account/chatgptAuthTokens/refresh\",\"params\":{\"reason\":\"unauthorized\",\"previousAccountId\":\"${secret}\"}}\n`,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(child.messages().at(-1)).toEqual({
      id: "refresh-failed",
      error: {
        code: -32603,
        message: "token refresh failed",
      },
    });
    expect(JSON.stringify(child.messages().at(-1))).not.toContain(secret);

    child.send('{"id":7,"method":"thread/start","params":{"secret":"payload"}}\n');
    expect(child.messages().at(-1)).toEqual({
      id: 7,
      error: {
        code: -32601,
        message: "server request unsupported by trusted broker",
      },
    });
    client.close();
  });

  test("drains child stderr without forwarding secret-bearing output to logs", async () => {
    const child = new FakeAppServerProcess();
    const consoleError = mock(() => undefined);
    const consoleWarn = mock(() => undefined);
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = consoleError;
    console.warn = consoleWarn;

    try {
      const client = createClient(child);
      expect(child.stderr.readableFlowing).toBe(true);
      child.stderr.write("access_token=stderr-secret\n".repeat(10_000));
      await Promise.resolve();
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      client.close();
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
  });

  test("times out one request, rejects other pending requests, and closes the child", async () => {
    const child = new FakeAppServerProcess();
    const onClose = mock(() => undefined);
    const client = createClient(child, { onClose, requestTimeoutMs: 10 });
    await initialize(child);

    const first = client.request("account/read", { refreshToken: false });
    const second = client.request("account/logout", undefined);

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult).toMatchObject({
      status: "rejected",
      reason: {
        name: "CodexAppServerAuthError",
        code: "app_server_rejected",
      },
    });
    expect(secondResult).toMatchObject({
      status: "rejected",
      reason: {
        name: "CodexAppServerAuthError",
        code: "app_server_rejected",
      },
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("rejects pending requests when the child exits", async () => {
    const child = new FakeAppServerProcess();
    const onClose = mock(() => undefined);
    const client = createClient(child, { onClose });
    await initialize(child);

    const pending = client.request("account/read", { refreshToken: false });
    await Promise.resolve();
    child.emit("exit", 1, null);

    await expect(pending).rejects.toMatchObject({
      name: "CodexAppServerAuthError",
      code: "app_server_rejected",
    } satisfies Partial<CodexAppServerAuthError>);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("evicts a timed-out cached client and cleanly spawns a replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const children = [new FakeAppServerProcess(), new FakeAppServerProcess()];
    let spawnCount = 0;
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        requestTimeoutMs: 10,
        spawnAppServer: () => children[spawnCount++]!.asChild(),
      }),
      () => join(root, "scoped-home"),
    );
    const scope = { orgId: "org-transport", userId: "user-transport" };

    try {
      const first = await pool.get(scope);
      await initialize(children[0]!);
      const pending = first.request("account/read", { refreshToken: false });
      await expect(pending).rejects.toBeInstanceOf(CodexAppServerAuthError);

      const replacement = await pool.get(scope);
      expect(replacement).not.toBe(first);
      expect(spawnCount).toBe(2);
      expect(children[1]!.messages()[0]).toMatchObject({ id: 1, method: "initialize" });
      children[1]!.send('{"id":1,"result":{}}\n');
      replacement.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shares one client per scope and creates its home with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const child = new FakeAppServerProcess();
    let spawnCount = 0;
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        spawnAppServer: () => {
          spawnCount += 1;
          return child.asChild();
        },
      }),
      (scope) => join(root, `${scope.orgId}-${scope.userId}`),
    );
    const scope = { orgId: "org-cache", userId: "user-cache" };

    try {
      const [first, second] = await Promise.all([pool.get(scope), pool.get(scope)]);

      expect(second).toBe(first);
      expect(spawnCount).toBe(1);
      expect((await stat(first.codexHome)).mode & 0o777).toBe(0o700);
      first.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds refresh handling to the current scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const child = new FakeAppServerProcess();
    const scope = { orgId: "org-bound", userId: "user-bound" };
    const refreshTokens = mock(async (input: {
      scope: typeof scope;
      request: CodexChatGptRefreshRequest;
    }): Promise<CodexChatGptRefreshResponse> => ({
      accessToken: `${input.scope.orgId}-token`,
      chatgptAccountId: input.request.previousAccountId ?? input.scope.userId,
      chatgptPlanType: null,
    }));
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        spawnAppServer: () => child.asChild(),
      }),
      () => join(root, "scoped-home"),
      { refreshTokens },
    );

    try {
      const client = await pool.get(scope);
      await initialize(child);
      child.send(
        '{"id":9,"method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized"}}\n',
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(refreshTokens).toHaveBeenCalledWith({
        scope,
        request: { reason: "unauthorized" },
      });
      expect(child.messages().at(-1)).toEqual({
        id: 9,
        result: {
          accessToken: "org-bound-token",
          chatgptAccountId: "user-bound",
          chatgptPlanType: null,
        },
      });
      client.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("contains failed login completion, closes only the affected client, and evicts it", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const children = [
      new FakeAppServerProcess(),
      new FakeAppServerProcess(),
      new FakeAppServerProcess(),
    ];
    const secret = "org-user-payload-secret";
    const loginCompletion = mock(async () => {
      throw new Error(secret);
    });
    let spawnCount = 0;
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        spawnAppServer: () => children[spawnCount++]!.asChild(),
      }),
      () => join(root, "scoped-home"),
      { loginCompletion },
    );
    const scope = { orgId: `org-${secret}`, userId: `user-${secret}` };
    const unaffectedScope = { orgId: "org-unaffected", userId: "user-unaffected" };
    let unhandled: unknown;
    const onUnhandled = (error: unknown) => {
      unhandled = error;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const first = await pool.get(scope);
      await initialize(children[0]!);
      const unaffected = await pool.get(unaffectedScope);
      await initialize(children[1]!);
      children[0]!.send(
        `{\"method\":\"account/login/completed\",\"params\":{\"loginId\":\"${secret}\",\"success\":true}}\n`,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Bun.sleep(0);

      expect(loginCompletion).toHaveBeenCalledTimes(1);
      expect(unhandled).toBeUndefined();
      expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
      expect(children[1]!.kill).not.toHaveBeenCalled();
      expect(await pool.get(unaffectedScope)).toBe(unaffected);

      const replacement = await pool.get(scope);
      expect(replacement).not.toBe(first);
      expect(spawnCount).toBe(3);
      unaffected.close();
      replacement.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("closes an abandoned login from the client creation deadline and allows replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const children = [new FakeAppServerProcess(), new FakeAppServerProcess()];
    let spawnCount = 0;
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        spawnAppServer: () => children[spawnCount++]!.asChild(),
      }),
      () => join(root, "scoped-home"),
      {},
      { loginDeadlineMs: 20 },
    );
    const scope = { orgId: "org-abandoned", userId: "user-abandoned" };

    try {
      const abandoned = await pool.get(scope);
      await initialize(children[0]!);
      await Bun.sleep(40);

      expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
      const replacement = await pool.get(scope);
      expect(replacement).not.toBe(abandoned);
      expect(spawnCount).toBe(2);
      replacement.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cancelling login evicts only that scope and does not leak a rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const children = [
      new FakeAppServerProcess(),
      new FakeAppServerProcess(),
      new FakeAppServerProcess(),
    ];
    let spawnCount = 0;
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        spawnAppServer: () => children[spawnCount++]!.asChild(),
      }),
      () => join(root, "scoped-home"),
    );
    const broker = createManagedCodexChatGptBroker(pool);
    const cancelledScope = { orgId: "org-cancelled", userId: "user-cancelled" };
    const unaffectedScope = { orgId: "org-unaffected", userId: "user-unaffected" };
    let unhandled: unknown;
    const onUnhandled = (error: unknown) => {
      unhandled = error;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const cancelled = await pool.get(cancelledScope);
      await initialize(children[0]!);
      const unaffected = await pool.get(unaffectedScope);
      await initialize(children[1]!);

      const cancellation = broker.cancel({ scope: cancelledScope, loginId: "login-cancelled" });
      await Bun.sleep(0);
      expect(children[0]!.messages().at(-1)).toMatchObject({
        id: 2,
        method: "account/login/cancel",
        params: { loginId: "login-cancelled" },
      });
      children[0]!.send('{"id":2,"result":{"status":"cancelled"}}\n');
      await expect(cancellation).resolves.toEqual({ status: "cancelled" });
      await Bun.sleep(0);

      expect(unhandled).toBeUndefined();
      expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
      expect(children[1]!.kill).not.toHaveBeenCalled();
      expect(await pool.get(unaffectedScope)).toBe(unaffected);
      expect(await pool.get(cancelledScope)).not.toBe(cancelled);
      unaffected.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("evicts the scoped client when login start fails", async () => {
    const scope = { orgId: "org-start-failure", userId: "user-start-failure" };
    const appServer = {
      codexHome: "/tmp/codex-start-failure",
      close: mock(() => undefined),
      onNotification: () => () => undefined,
      request: mock(async () => {
        throw new CodexAppServerAuthError("app_server_rejected");
      }),
    };
    const lifecycle = {
      get: mock(async () => appServer),
      evict: mock((_scope: typeof scope, client?: typeof appServer) => client?.close()),
    };
    const broker = createManagedCodexChatGptBroker(lifecycle);

    await expect(broker.start({ scope })).rejects.toMatchObject({
      code: "app_server_rejected",
    });
    expect(lifecycle.evict).toHaveBeenCalledWith(scope, appServer);
    expect(appServer.close).toHaveBeenCalledTimes(1);
  });

  test("terminal login failure evicts only that scope while successful login remains reusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const children = [
      new FakeAppServerProcess(),
      new FakeAppServerProcess(),
      new FakeAppServerProcess(),
    ];
    let spawnCount = 0;
    const loginCompletion = mock(async (input: { notification: unknown }) => {
      return (input.notification as { success?: unknown }).success === true;
    });
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        spawnAppServer: () => children[spawnCount++]!.asChild(),
      }),
      () => join(root, "scoped-home"),
      { loginCompletion },
    );
    const failedScope = { orgId: "org-failed", userId: "user-failed" };
    const successfulScope = { orgId: "org-success", userId: "user-success" };

    try {
      const failed = await pool.get(failedScope);
      await initialize(children[0]!);
      const successful = await pool.get(successfulScope);
      await initialize(children[1]!);
      children[0]!.send(
        '{"method":"account/login/completed","params":{"loginId":"failed","success":false,"error":"denied"}}\n',
      );
      children[1]!.send(
        '{"method":"account/login/completed","params":{"loginId":"success","success":true,"error":null}}\n',
      );
      await Bun.sleep(0);

      expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
      expect(children[1]!.kill).not.toHaveBeenCalled();
      expect(await pool.get(successfulScope)).toBe(successful);
      expect(await pool.get(failedScope)).not.toBe(failed);
      successful.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects excess scopes without evicting another user or starting another process", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const children = [new FakeAppServerProcess(), new FakeAppServerProcess()];
    let spawnCount = 0;
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        spawnAppServer: () => children[spawnCount++]!.asChild(),
      }),
      (scope) => join(root, `${scope.orgId}-${scope.userId}`),
      {},
      { maxClients: 2 },
    );
    const firstScope = { orgId: "org-cap", userId: "user-one" };
    const secondScope = { orgId: "org-cap", userId: "user-two" };

    try {
      const first = await pool.get(firstScope);
      const second = await pool.get(secondScope);
      await expect(
        pool.get({ orgId: "org-cap", userId: "user-three" }),
      ).rejects.toMatchObject({ code: "app_server_rejected" });

      expect(spawnCount).toBe(2);
      expect(children[0]!.kill).not.toHaveBeenCalled();
      expect(children[1]!.kill).not.toHaveBeenCalled();
      expect(await pool.get(firstScope)).toBe(first);
      expect(await pool.get(secondScope)).toBe(second);
      first.close();
      second.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps delimiter-like org and user IDs in distinct pool scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "skynet-codex-pool-"));
    const children = [new FakeAppServerProcess(), new FakeAppServerProcess()];
    let spawnCount = 0;
    const pool = new ManagedCodexAppServerClientPool(
      (input) => new CodexAppServerRpcClient({
        ...input,
        spawnAppServer: () => children[spawnCount++]!.asChild(),
      }),
      (scope) => join(root, `${scope.orgId.length}-${scope.orgId}-${scope.userId}`),
    );

    try {
      const first = await pool.get({ orgId: "org:shared", userId: "user" });
      const second = await pool.get({ orgId: "org", userId: "shared:user" });

      expect(second).not.toBe(first);
      expect(spawnCount).toBe(2);
      first.close();
      second.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
