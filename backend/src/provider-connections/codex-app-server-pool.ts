import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderConnectionScope } from "./repo";
import {
  CodexAppServerAuthError,
  type CodexChatGptRefreshRequest,
  type CodexChatGptRefreshResponse,
  type ManagedCodexAppServerClient,
} from "./codex-app-server-contracts";

const DEFAULT_LOGIN_DEADLINE_MS = 10 * 60_000;
const DEFAULT_MAX_CLIENTS = 64;

interface PoolEntry<T extends PooledCodexAppServerClient> {
  operation: Promise<T>;
  loginDeadline: ReturnType<typeof setTimeout>;
  authenticated: boolean;
}

export interface CodexAppServerClientPoolOptions {
  loginDeadlineMs?: number;
  maxClients?: number;
}

/*
 * scheduleIdleClose starts the post-login idle window. Before login completes,
 * the pool owns a separate hard deadline measured from client creation.
 */
export interface PooledCodexAppServerClient extends ManagedCodexAppServerClient {
  scheduleIdleClose(): void;
}

export interface PooledCodexAppServerClientInput {
  codexHome: string;
  onClose: () => void;
  onNotification: (method: string, params: unknown) => void;
  handleChatGptAuthTokensRefresh: (
    request: CodexChatGptRefreshRequest,
  ) => Promise<CodexChatGptRefreshResponse>;
}

export type PooledCodexAppServerClientFactory<T extends PooledCodexAppServerClient> = (
  input: PooledCodexAppServerClientInput,
) => T;

type LoginCompletionHandler<T extends PooledCodexAppServerClient> = (input: {
  scope: ProviderConnectionScope;
  appServer: T;
  notification: unknown;
}) => Promise<boolean>;

type RefreshTokensHandler = (input: {
  scope: ProviderConnectionScope;
  request: CodexChatGptRefreshRequest;
}) => Promise<CodexChatGptRefreshResponse>;

export class CodexAppServerClientPool<T extends PooledCodexAppServerClient> {
  private readonly clients = new Map<string, PoolEntry<T>>();
  private readonly loginDeadlineMs: number;
  private readonly maxClients: number;

  constructor(
    private readonly createClient: PooledCodexAppServerClientFactory<T>,
    private readonly homeForScope: (scope: ProviderConnectionScope) => string,
    private readonly handleLoginCompletion: LoginCompletionHandler<T>,
    private readonly refreshTokens: RefreshTokensHandler,
    options: CodexAppServerClientPoolOptions = {},
  ) {
    this.loginDeadlineMs = positiveIntegerOrDefault(
      options.loginDeadlineMs,
      DEFAULT_LOGIN_DEADLINE_MS,
    );
    this.maxClients = positiveIntegerOrDefault(options.maxClients, DEFAULT_MAX_CLIENTS);
  }

  async get(scope: ProviderConnectionScope): Promise<T> {
    const key = scopeKey(scope);
    const existing = this.clients.get(key);
    if (existing) {
      const client = await existing.operation;
      if (existing.authenticated && this.clients.get(key) === existing) {
        client.scheduleIdleClose();
      }
      return client;
    }
    if (this.clients.size >= this.maxClients) {
      throw new CodexAppServerAuthError("app_server_rejected");
    }

    let entry: PoolEntry<T>;
    const operation = (async () => {
      const codexHome = this.homeForScope(scope);
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      const client = this.createClient({
        codexHome,
        onClose: () => this.removeEntry(key, entry),
        onNotification: (method, params) => {
          if (method !== "account/login/completed") return;
          void this.handleLoginCompletionSafely({
            key,
            entry,
            scope,
            appServer: client,
            notification: params,
          });
        },
        handleChatGptAuthTokensRefresh: (request) => this.refreshTokens({ scope, request }),
      });
      return client;
    })();
    const loginDeadline = setTimeout(() => this.closeEntry(key, entry), this.loginDeadlineMs);
    loginDeadline.unref?.();
    entry = { operation, loginDeadline, authenticated: false };
    this.clients.set(key, entry);
    void this.evictFailedOperation(key, entry);
    return operation;
  }

  evict(scope: ProviderConnectionScope, appServer?: ManagedCodexAppServerClient): void {
    const key = scopeKey(scope);
    const entry = this.clients.get(key);
    if (!entry) {
      if (appServer) safeClose(appServer);
      return;
    }
    if (!appServer) {
      this.closeEntry(key, entry);
      return;
    }

    safeClose(appServer);
    void this.removeEntryIfClientMatches(key, entry, appServer);
  }

  private removeEntry(key: string, entry: PoolEntry<T>): void {
    if (this.clients.get(key) !== entry) return;
    this.clients.delete(key);
    clearTimeout(entry.loginDeadline);
  }

  private closeEntry(key: string, entry: PoolEntry<T>, client?: T): void {
    this.removeEntry(key, entry);
    if (client) {
      safeClose(client);
      return;
    }
    void closeResolvedClient(entry.operation);
  }

  private async removeEntryIfClientMatches(
    key: string,
    entry: PoolEntry<T>,
    appServer: ManagedCodexAppServerClient,
  ): Promise<void> {
    try {
      if (await entry.operation === appServer) this.removeEntry(key, entry);
    } catch {
      this.removeEntry(key, entry);
    }
  }

  private async evictFailedOperation(key: string, entry: PoolEntry<T>): Promise<void> {
    try {
      await entry.operation;
    } catch {
      this.removeEntry(key, entry);
    }
  }

  private async handleLoginCompletionSafely(input: {
    key: string;
    entry: PoolEntry<T>;
    scope: ProviderConnectionScope;
    appServer: T;
    notification: unknown;
  }): Promise<void> {
    try {
      const authenticated = await this.handleLoginCompletion({
        scope: input.scope,
        appServer: input.appServer,
        notification: input.notification,
      });
      if (!authenticated) {
        this.closeEntry(input.key, input.entry, input.appServer);
        return;
      }
      if (this.clients.get(input.key) !== input.entry) {
        safeClose(input.appServer);
        return;
      }
      clearTimeout(input.entry.loginDeadline);
      input.entry.authenticated = true;
      input.appServer.scheduleIdleClose();
    } catch {
      this.closeEntry(input.key, input.entry, input.appServer);
    }
  }
}

export function codexHomeForScope(scope: ProviderConnectionScope): string {
  const digest = createHash("sha256").update(scopeKey(scope)).digest("hex").slice(0, 32);
  return join(defaultCodexHomeRoot(), digest);
}

function defaultCodexHomeRoot(): string {
  return process.env.CODEX_APP_SERVER_HOME_ROOT?.trim() || join(process.cwd(), ".skynet/codex-app-server");
}

function scopeKey(scope: ProviderConnectionScope): string {
  return JSON.stringify([scope.orgId, scope.userId]);
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

function safeClose(client: ManagedCodexAppServerClient): void {
  try {
    client.close();
  } catch {
    // Eviction must remain contained even if a child-process wrapper misbehaves.
  }
}

async function closeResolvedClient<T extends ManagedCodexAppServerClient>(
  operation: Promise<T>,
): Promise<void> {
  try {
    safeClose(await operation);
  } catch {
    // A failed construction has no live client to close.
  }
}
