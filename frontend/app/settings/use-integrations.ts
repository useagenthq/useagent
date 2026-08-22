"use client";

import { useCallback, useEffect, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import type { IntegrationSummary } from "./integration-connections-data";
import {
  completeIntegrationConnect,
  disconnectIntegration,
  fetchIntegrations,
  startIntegrationConnect,
} from "./integrations-api";

const POLL_INTERVAL_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function useIntegrations() {
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setIntegrations(await fetchIntegrations());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useOrgChanges((change) => {
    if (change.type === "integration_connection") void load();
  });

  const connect = useCallback(
    async (provider: string) => {
      setBusyProvider(provider);
      setActionError(null);
      try {
        const started = await startIntegrationConnect(provider);
        const popup = window.open(
          started.redirectUrl,
          `useagent-connect-${provider}`,
          "popup,width=640,height=760",
        );
        if (!popup) throw new Error("popup blocked");
        const expiresAt = started.expiresAt ? Date.parse(started.expiresAt) : NaN;
        const deadline = Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60_000;
        while (Date.now() < deadline) {
          await delay(POLL_INTERVAL_MS);
          if (await completeIntegrationConnect(started.state)) {
            popup.close();
            await load();
            return;
          }
          if (popup.closed) break;
        }
        throw new Error("authorization did not complete");
      } catch {
        setActionError("Couldn't complete the connection flow.");
      } finally {
        setBusyProvider(null);
      }
    },
    [load],
  );

  const disconnect = useCallback(
    async (provider: string, connectionId: string) => {
      setBusyProvider(provider);
      setActionError(null);
      try {
        await disconnectIntegration(provider, connectionId);
        await load();
      } catch {
        setActionError("Couldn't disconnect that integration.");
      } finally {
        setBusyProvider(null);
      }
    },
    [load],
  );

  return {
    actionError,
    busyProvider,
    connect,
    disconnect,
    error,
    integrations,
    load,
    loading,
    refreshing,
  };
}
