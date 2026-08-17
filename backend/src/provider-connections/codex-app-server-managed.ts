import {
  storeManagedCodexAppServerProviderConnection,
  revokeCurrentUserProviderConnection,
  type ProviderConnectionMeta,
} from "./service";
import type { ProviderConnectionScope } from "./repo";
import type { ProviderConnectionMetadata } from "./types";
import {
  completeCodexChatGptAppServerLogin,
  cancelCodexChatGptAppServerLogin,
  readCodexChatGptAppServerStatus,
  startCodexChatGptAccountLogin,
} from "./codex-app-server-account";
import type {
  CodexAppServerLoginStartResult,
  CodexChatGptStatus,
  ManagedCodexAppServerClient,
} from "./codex-app-server-contracts";

interface ManagedClientLifecycle {
  get(scope: ProviderConnectionScope): Promise<ManagedCodexAppServerClient>;
  evict(scope: ProviderConnectionScope, appServer?: ManagedCodexAppServerClient): void;
}

export function createManagedCodexChatGptBroker(lifecycle: ManagedClientLifecycle) {
  return {
    start: async (input: {
      scope: ProviderConnectionScope;
      loginMethod?: "chatgpt" | "device_code";
      appServer?: ManagedCodexAppServerClient;
    }): Promise<CodexAppServerLoginStartResult> => {
      const appServer = input.appServer ?? await lifecycle.get(input.scope);
      try {
        return await startCodexChatGptAccountLogin(appServer, input.loginMethod);
      } catch (error) {
        lifecycle.evict(input.scope, appServer);
        throw error;
      }
    },
    cancel: async (input: {
      scope: ProviderConnectionScope;
      loginId: string;
      appServer?: ManagedCodexAppServerClient;
    }): Promise<{ status: string }> => {
      const appServer = input.appServer ?? await lifecycle.get(input.scope);
      try {
        return await cancelCodexChatGptAppServerLogin({ appServer, loginId: input.loginId });
      } finally {
        lifecycle.evict(input.scope, appServer);
      }
    },
    readStatus: async (input: {
      scope: ProviderConnectionScope;
      appServer?: ManagedCodexAppServerClient;
    }): Promise<CodexChatGptStatus> => {
      const appServer = input.appServer ?? await lifecycle.get(input.scope);
      const status = await readCodexChatGptAppServerStatus(appServer);
      await persistManagedAccount(input.scope, appServer, status.account, false);
      return status;
    },
    revoke: async (input: {
      scope: ProviderConnectionScope;
      appServer?: ManagedCodexAppServerClient;
    }): Promise<ProviderConnectionMeta | null> => {
      const appServer = input.appServer ?? await lifecycle.get(input.scope);
      try {
        // Keep the durable connection until the host-side OAuth material is
        // definitely revoked. Otherwise a transient app-server failure can leave
        // live credentials on disk while the UI incorrectly reports "revoked".
        await appServer.request("account/logout", undefined);
      } finally {
        lifecycle.evict(input.scope, appServer);
      }
      return revokeCurrentUserProviderConnection({
        ...input.scope,
        provider: "openai",
        authMethod: "chatgpt_oauth",
      });
    },
  };
}

export async function handleManagedCodexChatGptLoginCompleted(input: {
  scope: ProviderConnectionScope;
  appServer: ManagedCodexAppServerClient;
  notification: unknown;
}): Promise<ProviderConnectionMeta | null> {
  // The app server is an external process; tolerate both camelCase and
  // snake_case completion params rather than dropping a real login on a naming
  // mismatch (a dropped completion strands the durable row as revoked/stale).
  const raw = input.notification && typeof input.notification === "object"
    ? input.notification as Record<string, unknown>
    : {};
  const completion = completeCodexChatGptAppServerLogin({
    loginId: typeof raw.loginId === "string"
      ? raw.loginId
      : typeof raw.login_id === "string" ? raw.login_id : null,
    success: raw.success === true,
    error: typeof raw.error === "string" ? raw.error : null,
  });
  if (!completion.success) return null;
  const status = await readCodexChatGptAppServerStatus(input.appServer);
  return persistManagedAccount(input.scope, input.appServer, status.account, true);
}

async function persistManagedAccount(
  scope: ProviderConnectionScope,
  client: ManagedCodexAppServerClient,
  account: CodexChatGptStatus["account"],
  allowReconnect: boolean,
): Promise<ProviderConnectionMeta | null> {
  if (account?.authMode !== "chatgpt") return null;
  return storeManagedCodexAppServerProviderConnection({
    ...scope,
    session: {
      type: "managed_codex_app_server",
      codexHome: client.codexHome,
      ...(account.email ? { email: account.email } : {}),
      ...(account.planType ? { planType: account.planType } : {}),
      connectedAt: new Date().toISOString(),
    },
    metadata: metadataFromAccount(account),
    allowReconnect,
  });
}

function metadataFromAccount(account: CodexChatGptStatus["account"]): ProviderConnectionMetadata {
  return {
    ...(account?.email ? { email: account.email } : {}),
    ...(account?.planType ? { planType: account.planType } : {}),
  };
}
