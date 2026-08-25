/**
 * Collapse an integration list to one row per provider.
 *
 * The backend can surface the same provider twice - e.g. a connected GitHub App
 * installation AND an available OAuth backend for the same "github" provider -
 * which rendered as a duplicate "Connected" + "Not connected" pair on the Apps
 * page. A persisted connection projection wins over catalog/managed rows;
 * otherwise a connected managed row wins. List order stays stable.
 *
 * Generic over the minimal connectable shape so both the real IntegrationSummary
 * and test fixtures satisfy it without constructing the full wire type.
 */

export interface ConnectableSummary {
  provider: string;
  managed: boolean;
  status: string;
  connection: { status: string } | null;
}

/** True when a summary represents an established connection (a live connection,
 *  or a managed backend the org already has). */
export function isConnectedSummary(summary: ConnectableSummary): boolean {
  if (summary.connection?.status === "connected") return true;
  return summary.managed && summary.status === "connected";
}

export function dedupeIntegrations<T extends ConnectableSummary>(list: readonly T[]): T[] {
  const byProvider = new Map<string, T>();
  for (const summary of list) {
    const existing = byProvider.get(summary.provider);
    if (!existing) {
      byProvider.set(summary.provider, summary);
    } else if (
      (existing.connection === null && summary.connection !== null) ||
      (existing.connection === null &&
        summary.connection === null &&
        !isConnectedSummary(existing) &&
        isConnectedSummary(summary))
    ) {
      // A persisted connection is authoritative even when it needs attention.
      // Map.set on an existing key preserves the provider's original position.
      byProvider.set(summary.provider, summary);
    }
  }
  return [...byProvider.values()];
}
