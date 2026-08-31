"use client";

import {
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiLoader4Line,
  RiRefreshLine,
} from "@remixicon/react";
import { useMemo } from "react";
import { Button } from "@/components/base/buttons/button";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { cx } from "@/utils/cx";
import { ProviderConnectionPanel } from "./provider-connection-panel";
import {
  isActiveConnection,
  MODEL_PROVIDER_CONNECTION_PROVIDERS,
  providerConnectionViews,
} from "./provider-connections-data";
import { useProviderConnections } from "./use-provider-connections";

export function ProviderConnectionsCard() {
  const { connections, enabledSandboxEngines, error, load, loading, refreshing } =
    useProviderConnections();
  const views = useMemo(() => providerConnectionViews(connections), [connections]);
  const connectedCount = views.filter(
    (view) => isActiveConnection(view.apiKey) || isActiveConnection(view.chatGptOAuth),
  ).length;

  if (error && connections.length === 0) {
    return <BackendUnreachable onRetry={() => void load()} />;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-body-2-regular text-text-secondary">
          {connectedCount > 0 ? (
            <RiCheckboxCircleLine aria-hidden className="size-4 text-status-lime-text" />
          ) : (
            <RiCloseCircleLine aria-hidden className="size-4 text-foreground-icon-tertiary" />
          )}
          <span>
            {connectedCount} of {MODEL_PROVIDER_CONNECTION_PROVIDERS.length} providers connected
          </span>
        </div>
        <Button
          variant="secondary"
          size="xs"
          className="rounded-full"
          disabled={refreshing}
          onClick={() => void load()}
          leadingIcon={(props) => (
            <RiRefreshLine
              {...props}
              className={cx(props.className, refreshing && "animate-spin")}
            />
          )}
        >
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-body-2-regular text-text-secondary">
          <RiLoader4Line aria-hidden className="size-4 animate-spin" />
          Loading provider connections...
        </div>
      ) : (
        views.map((view) => (
          <ProviderConnectionPanel
            key={view.provider}
            provider={view.provider}
            connection={view.apiKey}
            oauthConnection={view.chatGptOAuth}
            codexSandboxExecutionEnabled={enabledSandboxEngines?.includes("codex") ?? null}
            onSaved={load}
          />
        ))
      )}

      {error && connections.length > 0 ? (
        <p className="text-caption-1-regular text-status-yellow-text">
          Refresh failed. Showing the last provider-connection snapshot.
        </p>
      ) : null}
    </div>
  );
}
