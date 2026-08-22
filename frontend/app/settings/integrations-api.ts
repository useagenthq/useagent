import {
  type ConnectionProjection,
  decodeConnectionProjection,
} from "@skynet/agent-client/integrations";
import { backendFetch } from "@/lib/backend-fetch";
import {
  decodeIntegrationSummaries,
  type IntegrationSummary,
} from "./integration-connections-data";

export async function fetchIntegrations(): Promise<IntegrationSummary[]> {
  const response = await backendFetch("/api/integrations", { cache: "no-store" });
  if (!response.ok) throw new Error(`integrations ${response.status}`);
  const payload = (await response.json()) as { integrations?: unknown };
  return decodeIntegrationSummaries(payload.integrations);
}

export interface IntegrationConnectStart {
  readonly redirectUrl: string;
  readonly state: string;
  readonly expiresAt: string | null;
}

export async function startIntegrationConnect(provider: string): Promise<IntegrationConnectStart> {
  const response = await backendFetch(`/api/integrations/${encodeURIComponent(provider)}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnTo: "/settings#integrations" }),
  });
  if (!response.ok) throw new Error(`integration-connect ${response.status}`);
  const payload = (await response.json()) as {
    redirectUrl?: unknown;
    state?: unknown;
    expiresAt?: unknown;
  };
  if (
    typeof payload.redirectUrl !== "string" ||
    !payload.redirectUrl.trim() ||
    typeof payload.state !== "string" ||
    !payload.state.trim()
  ) {
    throw new Error("integration-connect missing redirectUrl");
  }
  return {
    redirectUrl: payload.redirectUrl,
    state: payload.state,
    expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : null,
  };
}

export async function completeIntegrationConnect(
  state: string,
): Promise<ConnectionProjection | null> {
  const response = await backendFetch("/api/integrations/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
  // The backend reports a still-pending upstream authorization as a client
  // conflict/bad request. Polling may continue because the state is not consumed.
  if (response.status === 400 || response.status === 409) return null;
  if (!response.ok) throw new Error(`integration-callback ${response.status}`);
  const payload = (await response.json()) as { connection?: unknown };
  const connection = decodeConnectionProjection(payload.connection);
  if (!connection) throw new Error("integration-callback missing connection");
  return connection;
}

export async function disconnectIntegration(provider: string, connectionId: string): Promise<void> {
  const response = await backendFetch(
    `/api/integrations/${encodeURIComponent(provider)}?connectionId=${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(`integration-disconnect ${response.status}`);
}
