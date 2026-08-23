import {
  type ConnectionProjection,
  decodeConnectionProjection,
  decodeIntegrationConnectionAccount,
} from "@useagent/agent-client/integrations";

export const INTEGRATION_BACKENDS = ["native", "openconnector", "mcp"] as const;
export type IntegrationBackend = (typeof INTEGRATION_BACKENDS)[number];

export interface IntegrationSummary {
  readonly provider: string;
  readonly displayName: string;
  readonly description: string;
  readonly backend: IntegrationBackend;
  readonly managed: boolean;
  readonly connectAvailable: boolean;
  readonly disconnectAvailable: boolean;
  readonly status:
    | "connecting"
    | "connected"
    | "reauth_required"
    | "unhealthy"
    | "revoked"
    | "unavailable";
  readonly account?: ConnectionProjection["account"];
  readonly connection: ConnectionProjection | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isBackend(value: unknown): value is IntegrationBackend {
  return typeof value === "string" && (INTEGRATION_BACKENDS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is IntegrationSummary["status"] {
  return (
    typeof value === "string" &&
    ["connecting", "connected", "reauth_required", "unhealthy", "revoked", "unavailable"].includes(
      value,
    )
  );
}

export function decodeIntegrationSummary(value: unknown): IntegrationSummary | null {
  if (!isRecord(value)) return null;
  const provider = text(value.provider);
  const displayName = text(value.displayName);
  const description = text(value.description);
  if (
    !provider ||
    !displayName ||
    !description ||
    !isBackend(value.backend) ||
    !isStatus(value.status)
  )
    return null;

  const connection =
    value.connection === null ? null : decodeConnectionProjection(value.connection);
  if (value.connection !== null && !connection) return null;

  return {
    provider,
    displayName,
    description,
    backend: value.backend,
    managed: value.managed === true,
    // Capability flags fail closed. The UI never invents a lifecycle action.
    connectAvailable: value.connectAvailable === true,
    disconnectAvailable: value.disconnectAvailable === true,
    status: value.status,
    ...(isRecord(value.account)
      ? { account: decodeIntegrationConnectionAccount(value.account) }
      : {}),
    connection,
  };
}

export function decodeIntegrationSummaries(value: unknown): IntegrationSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(decodeIntegrationSummary)
    .filter((summary): summary is IntegrationSummary => summary !== null);
}

export function integrationAccountLabel(summary: IntegrationSummary): string | null {
  const account = summary.connection?.account ?? summary.account;
  return account?.displayName ?? account?.email ?? account?.externalAccountId ?? null;
}
