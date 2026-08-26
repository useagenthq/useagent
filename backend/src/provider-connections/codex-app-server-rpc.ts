import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CodexAppServerAuthError,
  type CodexChatGptRefreshRequest,
  type CodexChatGptRefreshResponse,
} from "./codex-app-server-contracts";

const REQUEST_TIMEOUT_MS = 15_000;
const IDLE_CLOSE_MS = 10 * 60_000;

interface CodexAppServerRpcTransportInput {
  child: ChildProcessWithoutNullStreams;
  onNotification?: (method: string, params: unknown) => void;
  onClose: () => void;
  handleChatGptAuthTokensRefresh?: (
    request: CodexChatGptRefreshRequest,
  ) => Promise<CodexChatGptRefreshResponse>;
  requestTimeoutMs?: number;
}

export class CodexAppServerRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private buffer = "";
  private readonly initialized: Promise<void>;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly onClose: () => void;
  private readonly handleChatGptAuthTokensRefresh?: (
    request: CodexChatGptRefreshRequest,
  ) => Promise<CodexChatGptRefreshResponse>;
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(reason?: unknown): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(input: CodexAppServerRpcTransportInput) {
    this.child = input.child;
    this.onClose = input.onClose;
    this.handleChatGptAuthTokensRefresh = input.handleChatGptAuthTokensRefresh;
    this.requestTimeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.child.stdout.setEncoding("utf8");
    if (input.onNotification) this.notificationListeners.add(input.onNotification);
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.resume();
    this.child.on("error", () => this.handleClose(new CodexAppServerAuthError("app_server_rejected")));
    this.child.on("exit", () => this.handleClose(new CodexAppServerAuthError("app_server_rejected")));
    this.initialized = this.initialize();
    void ignoreRejection(this.initialized);
  }

  protected async requestRpc(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (this.closed) throw new CodexAppServerAuthError("app_server_rejected");
    try {
      await this.initialized;
      return await this.send(method, params);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.child.kill("SIGTERM");
    this.handleClose(new CodexAppServerAuthError("app_server_rejected"));
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }

  private async initialize(): Promise<void> {
    await this.send("initialize", {
      clientInfo: { name: "useagent-provider-connections", title: null, version: "0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
        extensions: null,
      },
    });
    this.notify("initialized");
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) throw new CodexAppServerAuthError("app_server_rejected");
    const payload = params === undefined ? { method } : { method, params };
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      const error = new CodexAppServerAuthError("app_server_rejected");
      this.child.kill("SIGTERM");
      this.handleClose(error);
      throw error;
    }
  }

  private send(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ method, id, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new CodexAppServerAuthError("app_server_rejected");
        reject(error);
        this.child.kill("SIGTERM");
        this.handleClose(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.child.stdin.write(payload);
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        const error = new CodexAppServerAuthError("app_server_rejected");
        reject(error);
        this.child.kill("SIGTERM");
        this.handleClose(error);
      }
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as {
      id?: unknown;
      result?: unknown;
      error?: unknown;
      method?: unknown;
      params?: unknown;
    };
    if (typeof record.id === "number" && (record.result !== undefined || record.error !== undefined)) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timeout);
      if (record.error) pending.reject(new CodexAppServerAuthError("app_server_rejected"));
      else pending.resolve(record.result);
      return;
    }
    if (
      (typeof record.id === "number" || typeof record.id === "string") &&
      typeof record.method === "string"
    ) {
      this.handleServerRequest(record.id, record.method, record.params);
      return;
    }
    if (typeof record.method === "string") {
      for (const listener of this.notificationListeners) listener(record.method, record.params);
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    if (method !== "account/chatgptAuthTokens/refresh" || !this.handleChatGptAuthTokensRefresh) {
      this.writeServerResponse({
        id,
        error: { code: -32601, message: "server request unsupported by trusted broker" },
      });
      return;
    }
    const request = parseChatGptAuthTokensRefreshParams(params);
    if (!request) {
      this.writeServerResponse({
        id,
        error: { code: -32602, message: "invalid token refresh params" },
      });
      return;
    }
    void this.respondToChatGptAuthTokensRefresh(
      id,
      request,
      this.handleChatGptAuthTokensRefresh,
    );
  }

  private async respondToChatGptAuthTokensRefresh(
    id: number | string,
    request: CodexChatGptRefreshRequest,
    handler: (
      request: CodexChatGptRefreshRequest,
    ) => Promise<CodexChatGptRefreshResponse>,
  ): Promise<void> {
    try {
      const result = await handler(request);
      this.writeServerResponse({ id, result });
    } catch {
      this.writeServerResponse({
        id,
        error: { code: -32603, message: "token refresh failed" },
      });
    }
  }

  private writeServerResponse(response: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(response)}\n`);
    } catch {
      this.close();
    }
  }

  private handleClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.onClose();
  }
}

function parseChatGptAuthTokensRefreshParams(
  params: unknown,
): CodexChatGptRefreshRequest | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const keys = Object.keys(params);
  if (keys.some((key) => key !== "reason" && key !== "previousAccountId")) return null;
  const record = params as { reason?: unknown; previousAccountId?: unknown };
  if (record.reason !== "unauthorized") return null;
  if (
    "previousAccountId" in record &&
    record.previousAccountId !== null &&
    typeof record.previousAccountId !== "string"
  ) {
    return null;
  }
  return {
    reason: "unauthorized",
    ...(Object.hasOwn(record, "previousAccountId")
      ? { previousAccountId: record.previousAccountId as string | null }
      : {}),
  };
}

async function ignoreRejection(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // The caller observes the same failure through the retained promise.
  }
}
