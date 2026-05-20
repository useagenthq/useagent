import { backendFetch } from "@/lib/backend-fetch";
import {
  type CodexChatGptLogin,
  type CodexChatGptStatus,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMeta,
  type ProviderConnectionMetadata,
  type ProviderConnectionProvider,
  safeCodexChatGptLogin,
  safeCodexChatGptStatus,
  safeEnabledSandboxEngines,
  safeProviderConnectionMeta,
  safeProviderConnections,
} from "./provider-connections-data";

const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchProviderConnections(): Promise<ProviderConnectionMeta[]> {
  const res = await backendFetch("/api/provider-connections", { cache: "no-store" });
  if (!res.ok) throw new Error(`provider-connections ${res.status}`);
  const data = (await res.json()) as { connections?: unknown };
  return safeProviderConnections(data.connections);
}

export async function fetchEnabledSandboxEngines(): Promise<string[]> {
  const res = await backendFetch("/api/config", { cache: "no-store" });
  if (!res.ok) throw new Error(`sandbox-engines ${res.status}`);
  const data = (await res.json()) as { engines?: unknown };
  return safeEnabledSandboxEngines(data.engines);
}

export async function putProviderApiKey(input: {
  provider: ProviderConnectionProvider;
  apiKey: string;
  metadata?: ProviderConnectionMetadata;
}): Promise<ProviderConnectionMeta> {
  const res = await backendFetch(
    `/api/provider-connections/${encodeURIComponent(input.provider)}/api-key`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        apiKey: input.apiKey,
        metadata: input.metadata ?? {},
      }),
    },
  );
  if (!res.ok) throw new Error(`provider-api-key ${res.status}`);
  const data = (await res.json()) as { connection?: unknown };
  const connection = safeProviderConnectionMeta(data.connection);
  if (!connection) throw new Error("provider-api-key missing connection");
  return connection;
}

export async function revokeProviderConnection(input: {
  provider: ProviderConnectionProvider;
  authMethod: ProviderConnectionAuthMethod;
}): Promise<ProviderConnectionMeta> {
  const res = await backendFetch(
    `/api/provider-connections/${encodeURIComponent(
      input.provider,
    )}/revoke?authMethod=${encodeURIComponent(input.authMethod)}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`provider-revoke ${res.status}`);
  const data = (await res.json()) as { connection?: unknown };
  const connection = safeProviderConnectionMeta(data.connection);
  if (!connection) throw new Error("provider-revoke missing connection");
  return connection;
}

export async function startCodexChatGptLogin(): Promise<CodexChatGptLogin> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/start", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`codex-chatgpt-start ${res.status}`);
  const data = (await res.json()) as { login?: unknown };
  const login = safeCodexChatGptLogin(data.login);
  if (!login) throw new Error("codex-chatgpt-start missing login");
  return login;
}

export async function fetchCodexChatGptStatus(): Promise<CodexChatGptStatus> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/status", {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`codex-chatgpt-status ${res.status}`);
  const data = (await res.json()) as { status?: unknown };
  const status = safeCodexChatGptStatus(data.status);
  if (!status) throw new Error("codex-chatgpt-status missing status");
  return status;
}

export async function cancelCodexChatGptLogin(input: {
  loginId: string;
}): Promise<{ status: string }> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/cancel", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ loginId: input.loginId }),
  });
  if (!res.ok) throw new Error(`codex-chatgpt-cancel ${res.status}`);
  const data = (await res.json()) as { status?: unknown };
  if (typeof data.status !== "string") throw new Error("codex-chatgpt-cancel missing status");
  return { status: data.status };
}

export async function revokeCodexChatGptLogin(): Promise<ProviderConnectionMeta> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/revoke", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`codex-chatgpt-revoke ${res.status}`);
  const data = (await res.json()) as { connection?: unknown };
  const connection = safeProviderConnectionMeta(data.connection);
  if (!connection) throw new Error("codex-chatgpt-revoke missing connection");
  return connection;
}
