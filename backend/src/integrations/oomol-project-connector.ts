import { createHash, randomUUID } from "node:crypto";
import type {
  IntegrationActionCatalogEntry,
  IntegrationConnectionAccount,
} from "@useagent/agent-client/integrations";
import { Connector, ProjectConnector } from "@oomol-lab/connector";
import type { DelegatedConnectionBackend, IntegrationActorScope } from "./backend";

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_/-]{0,127}$/u;
const ACTION_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,255}$/u;
const PROVIDER_CONFIG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const DEFAULT_ORIGIN = "https://connector.oomol.com/v1";
const PROJECT_CONNECTOR_PROVIDERS = ["linear", "gmail", "notion", "hubspot"] as const;
const PROJECT_CONNECTOR_PROVIDER_SET = new Set<string>(PROJECT_CONNECTOR_PROVIDERS);

export interface OomolProjectConnectorConfig {
  readonly origin: string;
  readonly projectId: string;
  readonly projectApiKey: string;
  readonly catalogApiKey?: string;
  readonly returnUri: string;
  readonly providerConfigIds?: Readonly<Record<string, string>>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeOomolConnectorOrigin(raw: string): string {
  const url = new URL(raw.trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OOMOL_CONNECTOR_BASE_URL must not contain credentials, query, or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("OOMOL_CONNECTOR_BASE_URL requires HTTPS (HTTP is allowed only on loopback)");
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname && pathname !== "/v1") {
    throw new Error("OOMOL_CONNECTOR_BASE_URL must be an origin or end in /v1");
  }
  return `${url.origin}/v1`;
}

function parseProviderConfigIds(raw: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OOMOL_PROJECT_PROVIDER_CONFIGS must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("OOMOL_PROJECT_PROVIDER_CONFIGS must be a JSON object");
  }
  const result: Record<string, string> = {};
  for (const [provider, providerConfigId] of Object.entries(parsed)) {
    if (!PROVIDER_PATTERN.test(provider) || !PROJECT_CONNECTOR_PROVIDER_SET.has(provider)) {
      throw new Error(`invalid OOMOL provider mapping: ${provider}`);
    }
    const normalizedId = nonEmptyString(providerConfigId);
    if (!normalizedId || !PROVIDER_CONFIG_PATTERN.test(normalizedId)) {
      throw new Error(`invalid OOMOL provider config id for ${provider}`);
    }
    result[provider] = normalizedId;
  }
  return result;
}

export function oomolProjectConnectorConfigFromEnv(): OomolProjectConnectorConfig | null {
  const projectApiKey = process.env.OOMOL_PROJECT_API_KEY?.trim();
  const projectId = process.env.OOMOL_PROJECT_ID?.trim();
  const returnUri = process.env.OOMOL_CONNECT_RETURN_URI?.trim();
  const providerConfigs = process.env.OOMOL_PROJECT_PROVIDER_CONFIGS?.trim();
  if (!projectApiKey && !projectId && !returnUri && !providerConfigs) return null;
  if (!projectApiKey || !projectId || !returnUri) {
    console.warn("[integrations] OOMOL ProjectConnector is partially configured and remains disabled");
    return null;
  }
  if (!projectApiKey.startsWith("oo_proj_")) {
    console.warn("[integrations] OOMOL ProjectConnector disabled: project key must start with oo_proj_");
    return null;
  }
  try {
    const callback = new URL(returnUri);
    if (callback.protocol !== "https:" && !(callback.protocol === "http:" && isLoopback(callback.hostname))) {
      throw new Error("OOMOL_CONNECT_RETURN_URI requires HTTPS");
    }
    return {
      origin: normalizeOomolConnectorOrigin(
        process.env.OOMOL_CONNECTOR_BASE_URL?.trim() || DEFAULT_ORIGIN,
      ),
      projectId,
      projectApiKey,
      ...(process.env.OOMOL_API_KEY?.trim()
        ? { catalogApiKey: process.env.OOMOL_API_KEY.trim() }
        : {}),
      returnUri: callback.toString(),
      ...(providerConfigs ? { providerConfigIds: parseProviderConfigIds(providerConfigs) } : {}),
    };
  } catch (error) {
    console.warn(`[integrations] OOMOL ProjectConnector disabled: ${(error as Error).message}`);
    return null;
  }
}

export function oomolExternalUserId(scope: IntegrationActorScope): string {
  const orgId = scope.orgId.trim();
  const userId = scope.userId.trim();
  if (!orgId || !userId) throw new Error("orgId and userId are required");
  return `ua_${createHash("sha256").update(`${orgId}\0${userId}`).digest("hex")}`;
}

function safeExpiresAt(value: unknown): Date {
  const timestamp = Date.parse(nonEmptyString(value) ?? "");
  if (Number.isFinite(timestamp) && timestamp > Date.now()) return new Date(timestamp);
  return new Date(Date.now() + 10 * 60_000);
}

export function createOomolProjectConnectorBackend(
  config: OomolProjectConnectorConfig,
  fetchImpl: typeof fetch = fetch,
): DelegatedConnectionBackend {
  const runtimeBindingId = `oomol-project:${config.projectId}`;
  const project = new ProjectConnector({
    apiKey: config.projectApiKey,
    baseUrl: config.origin,
    fetch: fetchImpl,
  });
  const catalog = config.catalogApiKey
    ? new Connector({ apiKey: config.catalogApiKey, baseUrl: config.origin, fetch: fetchImpl })
    : null;

  function providerSelector(provider: string):
    | { readonly providerConfigId: string }
    | { readonly service: string } {
    if (!PROJECT_CONNECTOR_PROVIDER_SET.has(provider)) {
      throw new Error("integration provider is not supported by OOMOL");
    }
    const providerConfigId = config.providerConfigIds?.[provider];
    return providerConfigId ? { providerConfigId } : { service: provider };
  }

  return {
    kind: "delegated",
    runtimeBindingId,
    disconnectSupported: false,
    supports: (provider) => PROJECT_CONNECTOR_PROVIDER_SET.has(provider),
    async listConnectableProviders() {
      return PROJECT_CONNECTOR_PROVIDERS;
    },
    async startConnect(input) {
      const provider = input.provider;
      const selector = providerSelector(provider);
      const externalUserId = oomolExternalUserId(input);
      const connectionName = `ua_${randomUUID().replaceAll("-", "")}`;
      const returnUri = new URL(config.returnUri);
      returnUri.searchParams.set("state", input.state);
      const connectionRequest = await project.connect.oauth(externalUserId, {
        ...selector,
        connectionName,
        returnUri: returnUri.toString(),
      });
      const requestId = nonEmptyString(connectionRequest.id);
      const redirectUrl = nonEmptyString(connectionRequest.authorizationUrl);
      if (!requestId || !redirectUrl || new URL(redirectUrl).protocol !== "https:") {
        throw new Error("OOMOL Connector returned an invalid authorization request");
      }
      if (
        nonEmptyString(connectionRequest.projectId) !== config.projectId ||
        nonEmptyString(connectionRequest.externalUserId) !== externalUserId ||
        nonEmptyString(connectionRequest.service) !== provider ||
        ("providerConfigId" in selector &&
          nonEmptyString(connectionRequest.providerConfigId) !== selector.providerConfigId)
      ) {
        throw new Error(
          "OOMOL Connector returned a connection request for the wrong tenant or provider",
        );
      }
      return {
        backendSessionRef: requestId,
        runtimeBindingId,
        redirectUrl,
        expiresAt: safeExpiresAt(connectionRequest.expiresAt),
      };
    },
    async completeConnect(input) {
      const provider = input.provider;
      const selector = providerSelector(provider);
      const externalUserId = oomolExternalUserId(input);
      const connectionRequest = await project.getConnectionRequest(input.backendSessionRef);
      if (connectionRequest.status === "initiated") {
        throw new Error("integration authorization is not complete");
      }
      if (connectionRequest.status !== "connected") {
        throw new Error("integration authorization failed or expired");
      }
      if (
        nonEmptyString(connectionRequest.projectId) !== config.projectId ||
        nonEmptyString(connectionRequest.externalUserId) !== externalUserId ||
        nonEmptyString(connectionRequest.service) !== provider ||
        ("providerConfigId" in selector &&
          nonEmptyString(connectionRequest.providerConfigId) !== selector.providerConfigId)
      ) {
        throw new Error("OOMOL Connector returned a connection for the wrong tenant or provider");
      }
      const connectedAccountId = nonEmptyString(connectionRequest.connectedAccountId);
      if (!connectedAccountId) throw new Error("OOMOL Connector did not return a connected account");
      let account: IntegrationConnectionAccount = { externalAccountId: connectedAccountId };
      try {
        const { profile } = await project.getUserProfile(connectedAccountId);
        account = {
          externalAccountId: profile.id,
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          ...(profile.email ? { email: profile.email } : {}),
          ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
        };
      } catch {
        // Some providers do not expose a normalized profile; the opaque account id is sufficient.
      }
      return {
        runtimeBindingId,
        externalConnectionId: connectedAccountId,
        externalConnectionName: nonEmptyString(connectionRequest.connectionName) ?? null,
        authMethod: "oauth2",
        account,
        scopes: [],
      };
    },
    async disconnect() {
      throw new Error("OOMOL ProjectConnector does not expose a supported disconnect API");
    },
    async listActions(input) {
      const provider = input.connection.provider;
      providerSelector(provider);
      if (!catalog) {
        throw new Error(
          "OOMOL action catalog requires a separate server-side OOMOL_API_KEY; project auth does not expose catalog APIs",
        );
      }
      const rows = await catalog.catalog.actions(provider);
      return rows.flatMap((row): IntegrationActionCatalogEntry[] => {
        if (!isRecord(row)) return [];
        const actionId = nonEmptyString(row.id);
        if (!actionId || !ACTION_PATTERN.test(actionId) || !actionId.startsWith(`${provider}.`)) {
          return [];
        }
        return [{
          catalogVersion: 1,
          runtimeVersion: "oomol-connector-sdk@1.1.0",
          runtimeCommit: null,
          provider,
          actionId,
          publicName: nonEmptyString(row.name) ?? actionId.slice(provider.length + 1),
          description: nonEmptyString(row.description) ?? "",
          inputSchema: isRecord(row.inputSchema) ? row.inputSchema : {},
          effect: "write",
          approval: "interactive",
          timeoutMs: 30_000,
          maxResultBytes: 1_000_000,
          idempotent: false,
        }];
      });
    },
    async executeAction(input) {
      const provider = input.connection.provider;
      const selector = providerSelector(provider);
      if (!ACTION_PATTERN.test(input.actionId) || !input.actionId.startsWith(`${provider}.`)) {
        throw new Error("integration action does not belong to this provider");
      }
      if (!isRecord(input.input)) throw new Error("integration action input must be an object");
      const externalUserId = oomolExternalUserId({
        orgId: input.orgId,
        userId: input.connection.createdByUserId,
      });
      return project.execute(externalUserId, input.actionId, input.input, {
        ...selector,
        connectedAccountId: input.connection.externalConnectionId,
      });
    },
  };
}
