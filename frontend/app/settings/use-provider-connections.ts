"use client";

import { useCallback, useEffect, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import {
  fetchEnabledSandboxEngines,
  fetchProviderConnections,
} from "./provider-connections-api";
import type { ProviderConnectionMeta } from "./provider-connections-data";

export function useProviderConnections() {
  const [connections, setConnections] = useState<ProviderConnectionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [enabledSandboxEngines, setEnabledSandboxEngines] = useState<string[] | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const load = useCallback(async () => {
    setRefreshing(true);
    const [connectionsResult, enginesResult] = await Promise.allSettled([
      fetchProviderConnections(),
      fetchEnabledSandboxEngines(),
    ]);
    if (connectionsResult.status === "fulfilled") {
      setConnections(connectionsResult.value);
      setError(false);
    } else {
      setError(true);
    }
    setEnabledSandboxEngines(enginesResult.status === "fulfilled" ? enginesResult.value : null);
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
    enabledSandboxEngines,
    error,
    load,
    loading,
    mounted,
    refreshing,
  };
}
