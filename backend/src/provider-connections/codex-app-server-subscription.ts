import { getTrustedCodexSubscriptionAuth, type CodexSubscriptionAuth } from "./service";
import {
  CodexAppServerAuthError,
  type CodexAppServerClient,
  type CodexChatGptLoginSummary,
  type CodexChatGptRefreshRequest,
  type CodexChatGptRefreshResponse,
} from "./codex-app-server-contracts";
import type { ProviderConnectionScope } from "./repo";

export async function startCodexChatGptAppServerLogin(input: {
  appServer: CodexAppServerClient;
  scope: ProviderConnectionScope;
  nowMs?: number;
}): Promise<CodexChatGptLoginSummary> {
  const auth = await trustedAuth(input.scope, input.nowMs);
  const response = await input.appServer.request(
    "account/login/start",
    {
      type: "chatgptAuthTokens",
      accessToken: auth.accessToken,
      chatgptAccountId: auth.accountId,
      chatgptPlanType: auth.planType,
    },
  );
  if (
    !response ||
    typeof response !== "object" ||
    (response as { type?: unknown }).type !== "chatgptAuthTokens"
  ) {
    throw new CodexAppServerAuthError("app_server_rejected");
  }
  return {
    status: "started",
    accountId: auth.accountId,
    planType: auth.planType,
    expiresAt: auth.expiresAt,
  };
}

export async function refreshCodexChatGptAppServerTokens(input: {
  scope: ProviderConnectionScope;
  request: CodexChatGptRefreshRequest;
  nowMs?: number;
}): Promise<CodexChatGptRefreshResponse> {
  const auth = await trustedAuth(input.scope, input.nowMs);
  if (input.request.previousAccountId && input.request.previousAccountId !== auth.accountId) {
    throw new CodexAppServerAuthError("account_mismatch");
  }
  return {
    accessToken: auth.accessToken,
    chatgptAccountId: auth.accountId,
    chatgptPlanType: auth.planType,
  };
}

async function trustedAuth(
  scope: ProviderConnectionScope,
  nowMs = Date.now(),
): Promise<CodexSubscriptionAuth> {
  const auth = await getTrustedCodexSubscriptionAuth({ ...scope, provider: "openai" });
  if (!auth || (auth.expiresAt && Date.parse(auth.expiresAt) <= nowMs)) {
    throw new CodexAppServerAuthError("reauth_required");
  }
  return auth;
}
