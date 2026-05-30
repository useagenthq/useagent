"use client";

import { RiCheckLine, RiLoader4Line, RiRefreshLine, RiShieldCheckLine } from "@remixicon/react";
import { useMemo } from "react";
import { integrationVisual } from "@/app/apps/integrations";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { cnExt } from "@/utils/cn";
import { cx } from "@/utils/cx";
import { type IntegrationSummary, integrationAccountLabel } from "./integration-connections-data";
import { useIntegrations } from "./use-integrations";

function Status({ integration }: { integration: IntegrationSummary }) {
  if (integration.managed && integration.status === "connected") {
    return (
      <Chip variant="caption" color="soft" className="gap-1">
        <RiShieldCheckLine className="size-3.5" aria-hidden />
        Managed
      </Chip>
    );
  }
  if (integration.managed) {
    return (
      <Chip variant="caption" color="soft">
        Unavailable
      </Chip>
    );
  }
  if (integration.connection?.status === "connected") {
    return (
      <Chip variant="caption" color="lime" className="gap-1">
        <RiCheckLine className="size-3.5" aria-hidden />
        Connected
      </Chip>
    );
  }
  if (integration.connection?.status === "reauth_required") {
    return (
      <Chip variant="caption" color="yellow">
        Reconnect
      </Chip>
    );
  }
  if (integration.connection?.status === "unhealthy") {
    return (
      <Chip variant="caption" color="rose">
        Needs attention
      </Chip>
    );
  }
  return (
    <Chip variant="caption" color="soft">
      Not connected
    </Chip>
  );
}

function IntegrationRow({
  integration,
  busy,
  onConnect,
  onDisconnect,
}: {
  integration: IntegrationSummary;
  busy: boolean;
  onConnect: (provider: string) => void;
  onDisconnect: (provider: string, connectionId: string) => void;
}) {
  const visual = integrationVisual(integration.provider);
  const Icon = visual.icon;
  const accountLabel = integrationAccountLabel(integration);
  const connected = integration.connection?.status === "connected";
  const connectionId = connected ? integration.connection.id : null;

  return (
    <li className="flex items-center gap-3 py-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border-button-default bg-background-primary-default">
        <Icon className={cnExt("size-6", visual.iconClass)} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-body-2-medium text-text-primary">{integration.displayName}</p>
          <Status integration={integration} />
        </div>
        <p className="truncate text-body-2-regular text-text-secondary">
          {accountLabel ?? integration.description}
        </p>
      </div>
      {integration.connectAvailable && !connected ? (
        <Button
          size="xs"
          variant="secondary"
          className="rounded-full"
          disabled={busy}
          onClick={() => onConnect(integration.provider)}
        >
          {busy ? "Connecting..." : "Connect"}
        </Button>
      ) : null}
      {integration.disconnectAvailable && connectionId ? (
        <Button
          size="xs"
          variant="danger"
          className="rounded-full"
          disabled={busy}
          onClick={() => onDisconnect(integration.provider, connectionId)}
        >
          {busy ? "Disconnecting..." : "Disconnect"}
        </Button>
      ) : null}
    </li>
  );
}

export function IntegrationConnections({ query = "" }: { query?: string }) {
  const {
    actionError,
    busyProvider,
    connect,
    disconnect,
    error,
    integrations,
    load,
    loading,
    refreshing,
  } = useIntegrations();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return integrations;
    return integrations.filter(
      (integration) =>
        integration.displayName.toLowerCase().includes(normalized) ||
        integration.description.toLowerCase().includes(normalized),
    );
  }, [integrations, query]);

  if (error && integrations.length === 0) {
    return <BackendUnreachable onRetry={() => void load()} />;
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-body-2-regular text-text-secondary">
        <RiLoader4Line className="size-4 animate-spin" aria-hidden />
        Loading integrations...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption-1-regular text-text-secondary">
          {integrations.length} available integrations
        </p>
        <Button
          size="xs"
          variant="ghost"
          className="rounded-full"
          disabled={refreshing}
          leadingIcon={(props) => (
            <RiRefreshLine
              {...props}
              className={cx(props.className, refreshing && "animate-spin")}
            />
          )}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>
      {filtered.length > 0 ? (
        <ul className="grid grid-cols-1 divide-y divide-separator-border sm:grid-cols-2 sm:gap-x-10 sm:divide-y-0">
          {filtered.map((integration) => (
            <IntegrationRow
              key={`${integration.provider}:${integration.connection?.id ?? "managed"}`}
              integration={integration}
              busy={busyProvider === integration.provider}
              onConnect={(provider) => void connect(provider)}
              onDisconnect={(provider, connectionId) => void disconnect(provider, connectionId)}
            />
          ))}
        </ul>
      ) : (
        <p className="py-5 text-body-2-regular text-text-secondary">
          No integrations match your search.
        </p>
      )}
      {actionError ? (
        <p role="alert" className="text-caption-1-regular text-status-rose-text">
          {actionError}
        </p>
      ) : null}
      {error && integrations.length > 0 ? (
        <p className="text-caption-1-regular text-status-yellow-text">
          Refresh failed. Showing the last integrations snapshot.
        </p>
      ) : null}
    </div>
  );
}
