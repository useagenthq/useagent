import { randomUUID } from "node:crypto";
import type { IntegrationActionCatalogEntry } from "@skynet/agent-client/integrations";
import type { DelegatedConnectionBackend } from "./backend";

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_/-]{0,127}$/u;
const ACTION_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,255}$/u;
const REQUEST_TIMEOUT_MS = 8_000;

interface OpenConnectorConfig {
  readonly origin: string;
  readonly adminToken: string;
  readonly runtimeToken: string;
}

interface OpenConnectorConnection {
  readonly id?: unknown;
  readonly service?: unknown;
  readonly connectionName?: unknown;
  readonly authType?: unknown;
  readonly configured?: unknown;
  readonly profile?: {
    readonly accountId?: unknown;
    readonly displayName?: unknown;
    readonly grantedScopes?: unknown;
  };
}

interface OpenConnectorOAuthConfig {
  readonly service?: unknown;
  readonly configured?: unknown;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeOpenConnectorOrigin(
  raw: string,
): string {
  const url = new URL(raw.trim());
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      "OPENCONNECTOR_BASE_URL must be an origin without credentials, path, query, or fragment",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new Error("OPENCONNECTOR_BASE_URL requires HTTPS (HTTP is allowed only on loopback)");
  }
  return url.origin;
}

export function openConnectorConfigFromEnv(): OpenConnectorConfig | null {
  const baseUrl = process.env.OPENCONNECTOR_BASE_URL?.trim();
  const adminToken = process.env.OPENCONNECTOR_ADMIN_TOKEN?.trim();
  const runtimeToken = process.env.OPENCONNECTOR_RUNTIME_TOKEN?.trim();
  if (!baseUrl && !adminToken && !runtimeToken) return null;
  if (!baseUrl || !adminToken || !runtimeToken) {
    console.warn("[integrations] OpenConnector is partially configured and remains disabled");
    return null;
  }
  try {
    return { origin: normalizeOpenConnectorOrigin(baseUrl), adminToken, runtimeToken };
  } catch (error) {
    console.warn(`[integrations] OpenConnector disabled: ${(error as Error).message}`);
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => stringValue(item) ?? []) : [];
}

export function createOpenConnectorBackend(
  config: OpenConnectorConfig,
  fetchImpl: typeof fetch = fetch,
): DelegatedConnectionBackend {
  async function request(path: string, init: RequestInit, runtime = false): Promise<unknown> {
    const response = await fetchImpl(`${config.origin}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${runtime ? config.runtimeToken : config.adminToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${response.status}`;
      throw new Error(`OpenConnector request failed: ${message}`);
    }
    return body;
  }

  function requireProvider(provider: string): string {
    if (!PROVIDER_PATTERN.test(provider)) throw new Error("invalid integration provider");
    return provider;
  }

  return {
    kind: "delegated",
    runtimeBindingId: `openconnector:${config.origin}`,
    supports: (provider) =>
      PROVIDER_PATTERN.test(provider) && provider !== "github" && provider !== "slack",
    async listConnectableProviders() {
      const rows = await request("/api/oauth/configs", { method: "GET" }) as OpenConnectorOAuthConfig[];
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        const provider = stringValue(row.service);
        return provider && row.configured === true && this.supports(provider) ? [provider] : [];
      });
    },
    async startConnect(input) {
      const provider = requireProvider(input.provider);
      const connectionName = `ua_${randomUUID().replaceAll("-", "")}`;
      const body = await request("/api/oauth/authorizations", {
        method: "POST",
        body: JSON.stringify({ service: provider, connectionName }),
      }) as Record<string, unknown>;
      const redirectUrl = stringValue(body.authorizationUrl);
      if (!redirectUrl || new URL(redirectUrl).protocol !== "https:") {
        throw new Error("OpenConnector returned an invalid authorization URL");
      }
      return {
        backendSessionRef: connectionName,
        runtimeBindingId: `openconnector:${config.origin}`,
        redirectUrl,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      };
    },
    async completeConnect(input) {
      const provider = requireProvider(input.provider);
      const rows = (await request("/api/connections", {
        method: "GET",
      })) as OpenConnectorConnection[];
      const connection = Array.isArray(rows)
        ? rows.find(
            (row) =>
              row.service === provider &&
              row.connectionName === input.backendSessionRef &&
              row.configured === true,
          )
        : undefined;
      const externalConnectionId = stringValue(connection?.id);
      if (!connection || !externalConnectionId) throw new Error("integration authorization is not complete");
      const authType = connection.authType === "api_key" || connection.authType === "custom_credential"
        ? connection.authType
        : "oauth2";
      return {
        runtimeBindingId: `openconnector:${config.origin}`,
        externalConnectionId,
        externalConnectionName: input.backendSessionRef,
        authMethod: authType,
        account: {
          ...(stringValue(connection.profile?.accountId)
            ? { externalAccountId: stringValue(connection.profile?.accountId) }
            : {}),
          ...(stringValue(connection.profile?.displayName)
            ? { displayName: stringValue(connection.profile?.displayName) }
            : {}),
        },
        scopes: stringArray(connection.profile?.grantedScopes),
      };
    },
    async disconnect(input) {
      const provider = requireProvider(input.connection.provider);
      const name = encodeURIComponent(input.connection.externalConnectionName ?? "default");
      await request(
        `/api/connections/${encodeURIComponent(provider)}?connectionName=${name}`,
        { method: "DELETE" },
      );
    },
    async listActions(input) {
      const provider = requireProvider(input.connection.provider);
      const body = (await request(
        `/v1/actions?service=${encodeURIComponent(provider)}`,
        { method: "GET" },
        true,
      )) as Record<string, unknown>;
      const rows = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : [];
      return rows.flatMap((row): IntegrationActionCatalogEntry[] => {
        if (!row || typeof row !== "object") return [];
        const item = row as Record<string, unknown>;
        const actionId = stringValue(item.id);
        if (
          !actionId ||
          !ACTION_PATTERN.test(actionId) ||
          !actionId.startsWith(`${provider}.`)
        ) {
          return [];
        }
        return [{
          catalogVersion: 1,
          runtimeVersion: "1.4.0",
          runtimeCommit: "96fb6afe8c244c7d6f3a8351df06d7b04137f6a6",
          provider,
          actionId,
          publicName: actionId.slice(provider.length + 1),
          description: stringValue(item.description) ?? "",
          inputSchema:
            item.inputSchema &&
            typeof item.inputSchema === "object" &&
            !Array.isArray(item.inputSchema)
              ? (item.inputSchema as Record<string, unknown>)
              : {},
          effect: "write",
          approval: "interactive",
          timeoutMs: 30_000,
          maxResultBytes: 1_000_000,
          idempotent: false,
        }];
      });
    },
    async executeAction(input) {
      if (
        !ACTION_PATTERN.test(input.actionId) ||
        !input.actionId.startsWith(`${input.connection.provider}.`)
      ) {
        throw new Error("integration action does not belong to this provider");
      }
      const alias = encodeURIComponent(input.connection.externalConnectionName ?? "default");
      return request(`/v1/actions/${encodeURIComponent(input.actionId)}?alias=${alias}`, {
        method: "POST",
        headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {},
        body: JSON.stringify({ input: input.input }),
      }, true);
    },
  };
}
