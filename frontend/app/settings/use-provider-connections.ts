"use client";

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { fetchDeploymentConfig, fetchProviderConnections } from "./provider-connections-api";
import type { ProviderConnectionProvider } from "./provider-connections-data";
import type { ProviderConnectionMeta } from "./provider-connections-data";

function useProviderConnectionsState() {
  const [connections, setConnections] = useState<ProviderConnectionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [enabledSandboxEngines, setEnabledSandboxEngines] = useState<string[] | null>(null);
  const [deploymentProviders, setDeploymentProviders] = useState<Partial<
    Record<ProviderConnectionProvider, boolean>
  > | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const load = useCallback(async () => {
    setRefreshing(true);
    const [connectionsResult, configResult] = await Promise.allSettled([
      fetchProviderConnections(),
      fetchDeploymentConfig(),
    ]);
    if (connectionsResult.status === "fulfilled") {
      setConnections(connectionsResult.value);
      setError(false);
    } else {
      setError(true);
    }
    const config = configResult.status === "fulfilled" ? configResult.value : null;
    setEnabledSandboxEngines(config?.enabledSandboxEngines ?? null);
    setDeploymentProviders(config?.deploymentProviders ?? null);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useOrgChanges((change) => {
    if (change.type === "provider_connection") void load();
  });

  return {
    connections,
    deploymentProviders,
    enabledSandboxEngines,
    error,
    load,
    loading,
    mounted,
    refreshing,
  };
}

type ProviderConnectionsState = ReturnType<typeof useProviderConnectionsState>;

const ProviderConnectionsContext = createContext<ProviderConnectionsState | null>(null);

export function ProviderConnectionsProvider({ children }: { readonly children: ReactNode }) {
  const value = useProviderConnectionsState();
  return createElement(ProviderConnectionsContext.Provider, { value }, children);
}

export function useProviderConnections(): ProviderConnectionsState {
  const value = useContext(ProviderConnectionsContext);
  if (!value) {
    throw new Error("useProviderConnections requires ProviderConnectionsProvider");
  }
  return value;
}
