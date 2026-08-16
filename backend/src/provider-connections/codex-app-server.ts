import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CodexAppServerAuthError,
  type CodexAppServerAccountMethod,
  type CodexChatGptRefreshRequest,
  type CodexChatGptRefreshResponse,
  type ManagedCodexAppServerClient,
} from "./codex-app-server-contracts";
import { CodexAppServerRpcTransport } from "./codex-app-server-rpc";
import {
  CodexAppServerClientPool,
  codexHomeForScope,
  type CodexAppServerClientPoolOptions,
  type PooledCodexAppServerClientFactory,
} from "./codex-app-server-pool";
import {
  createManagedCodexChatGptBroker,
  handleManagedCodexChatGptLoginCompleted,
} from "./codex-app-server-managed";
import { refreshCodexChatGptAppServerTokens } from "./codex-app-server-subscription";
import type { ProviderConnectionScope } from "./repo";

const CODEX_APP_SERVER_ACCOUNT_METHODS = [
  "account/login/start",
  "account/login/cancel",
  "account/read",
  "account/logout",
] as const;
const CODEX_APP_SERVER_ACCOUNT_METHOD_SET = new Set<string>(CODEX_APP_SERVER_ACCOUNT_METHODS);
const CODEX_APP_SERVER_ENV_KEYS = ["PATH"] as const;

export function isCodexAppServerAccountMethod(method: string): method is CodexAppServerAccountMethod {
  return CODEX_APP_SERVER_ACCOUNT_METHOD_SET.has(method);
}

export function codexAppServerChildEnvironment(
  codexHome: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const childEnv: Record<string, string> = { CODEX_HOME: codexHome };
  for (const key of CODEX_APP_SERVER_ENV_KEYS) {
    const value = env[key];
    if (value) childEnv[key] = value;
  }
  return childEnv;
}

interface CodexAppServerRpcClientInput {
  codexHome: string;
  onNotification?: (method: string, params: unknown) => void;
  onClose: () => void;
  handleChatGptAuthTokensRefresh?: (
    request: CodexChatGptRefreshRequest,
  ) => Promise<CodexChatGptRefreshResponse>;
  requestTimeoutMs?: number;
  spawnAppServer?: () => ChildProcessWithoutNullStreams;
}

/**
 * Account-only process boundary for Codex app-server external auth. The child
 * receives a scoped home and the allowlisted environment above, never the
 * backend's provider credentials.
 */
export class CodexAppServerRpcClient
  extends CodexAppServerRpcTransport
  implements ManagedCodexAppServerClient
{
  readonly codexHome: string;

  constructor(input: CodexAppServerRpcClientInput) {
    const child = input.spawnAppServer?.() ?? spawn("codex", ["app-server", "--stdio"], {
      env: codexAppServerChildEnvironment(input.codexHome),
      stdio: ["pipe", "pipe", "pipe"],
    });
    super({
      child,
      onClose: input.onClose,
      onNotification: input.onNotification,
      handleChatGptAuthTokensRefresh: input.handleChatGptAuthTokensRefresh,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    this.codexHome = input.codexHome;
  }

  async request(
    method: CodexAppServerAccountMethod,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (!isCodexAppServerAccountMethod(method)) {
      throw new CodexAppServerAuthError("app_server_rejected");
    }
    return this.requestRpc(method, params);
  }
}

type CodexAppServerRpcClientFactory = PooledCodexAppServerClientFactory<CodexAppServerRpcClient>;

interface ManagedCodexAppServerHandlers {
  refreshTokens?(input: {
    scope: ProviderConnectionScope;
    request: CodexChatGptRefreshRequest;
  }): Promise<CodexChatGptRefreshResponse>;
  loginCompletion?(input: {
    scope: ProviderConnectionScope;
    appServer: CodexAppServerRpcClient;
    notification: unknown;
  }): Promise<unknown>;
}

export class ManagedCodexAppServerClientPool
  extends CodexAppServerClientPool<CodexAppServerRpcClient>
{
  constructor(
    createClient: CodexAppServerRpcClientFactory = (input) => new CodexAppServerRpcClient(input),
    homeForScope: (scope: ProviderConnectionScope) => string = codexHomeForScope,
    handlers: ManagedCodexAppServerHandlers = {},
    options: CodexAppServerClientPoolOptions = {},
  ) {
    const refreshTokens = handlers.refreshTokens ?? refreshCodexChatGptAppServerTokens;
    const loginCompletion = handlers.loginCompletion ?? handleManagedCodexChatGptLoginCompleted;
    super(createClient, homeForScope, async ({ scope, appServer, notification }) => {
      return Boolean(await loginCompletion({ scope, appServer, notification }));
    }, refreshTokens, options);
  }
}

const managedClientPool = new ManagedCodexAppServerClientPool();
const managedBroker = createManagedCodexChatGptBroker(managedClientPool);

export const startManagedCodexChatGptLogin = managedBroker.start;
export const cancelManagedCodexChatGptLogin = managedBroker.cancel;
export const readManagedCodexChatGptStatus = managedBroker.readStatus;
export const revokeManagedCodexChatGptLogin = managedBroker.revoke;

export {
  cancelCodexChatGptAppServerLogin,
  completeCodexChatGptAppServerLogin,
  readCodexChatGptAppServerStatus,
} from "./codex-app-server-account";
export { handleManagedCodexChatGptLoginCompleted } from "./codex-app-server-managed";
export {
  refreshCodexChatGptAppServerTokens,
  startCodexChatGptAppServerLogin,
} from "./codex-app-server-subscription";
export {
  CodexAppServerAuthError,
  type CodexAppServerAccountMethod,
  type CodexAppServerClient,
  type CodexAppServerDeviceLoginStarted,
  type CodexAppServerLoginStarted,
  type CodexAppServerLoginStartResult,
  type CodexChatGptLoginCompletion,
  type CodexChatGptLoginSummary,
  type CodexChatGptRefreshRequest,
  type CodexChatGptRefreshResponse,
  type CodexChatGptStatus,
  type ManagedCodexAppServerClient,
} from "./codex-app-server-contracts";
