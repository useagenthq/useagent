export type CodexAppServerAccountMethod =
  | "account/login/start"
  | "account/login/cancel"
  | "account/read"
  | "account/logout";

export interface CodexAppServerClient {
  request(
    method: CodexAppServerAccountMethod,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown>;
}

export interface ManagedCodexAppServerClient extends CodexAppServerClient {
  readonly codexHome: string;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  close(): void;
}

export interface CodexAppServerLoginStarted {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

export interface CodexAppServerDeviceLoginStarted {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export type CodexAppServerLoginStartResult =
  | CodexAppServerLoginStarted
  | CodexAppServerDeviceLoginStarted;

export interface CodexChatGptLoginSummary {
  status: "started";
  accountId: string;
  planType: string;
  expiresAt: string | null;
}

export interface CodexChatGptLoginCompletion {
  status: "completed";
  loginId: string | null;
  success: boolean;
  error: string | null;
}

export interface CodexChatGptStatus {
  account: {
    authMode: string | null;
    email: string | null;
    planType: string | null;
  } | null;
  requiresOpenaiAuth: boolean;
}

export interface CodexChatGptRefreshRequest {
  reason: "unauthorized";
  previousAccountId?: string | null;
}

export interface CodexChatGptRefreshResponse {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}

export class CodexAppServerAuthError extends Error {
  constructor(
    readonly code: "reauth_required" | "account_mismatch" | "app_server_rejected",
  ) {
    super(code);
    this.name = "CodexAppServerAuthError";
  }
}
