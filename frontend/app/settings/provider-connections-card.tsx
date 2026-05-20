"use client";

import {
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiLoader4Line,
  RiRefreshLine,
} from "@remixicon/react";
import { useMemo } from "react";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import * as Button from "@/components/ui/button";
import { cnExt } from "@/utils/cn";
import { ProviderConnectionPanel } from "./provider-connection-panel";
import {
  isActiveConnection,
  PROVIDER_CONNECTION_PROVIDERS,
  providerConnectionViews,
} from "./provider-connections-data";
import { useProviderConnections } from "./use-provider-connections";

export function ProviderConnectionsCard() {
  const {
    connections,
    enabledSandboxEngines,
    error,
    load,
    loading,
    mounted,
    refreshing,
  } = useProviderConnections();
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
        <div className="flex items-center gap-2 text-paragraph-sm text-text-sub-600">
          {connectedCount > 0 ? (
            <RiCheckboxCircleLine aria-hidden className="size-4 text-success-base" />
          ) : (
            <RiCloseCircleLine aria-hidden className="size-4 text-text-soft-400" />
          )}
          <span>
            {connectedCount} of {PROVIDER_CONNECTION_PROVIDERS.length} providers connected
          </span>
        </div>
        <Button.Root
          type="button"
          variant="neutral"
          mode="stroke"
          size="xsmall"
          className="rounded-full"
          disabled={refreshing}
          onClick={() => void load()}
        >
          <Button.Icon
            as={RiRefreshLine}
            className={cnExt(refreshing ? "animate-spin" : undefined)}
          />
          Refresh
        </Button.Root>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-paragraph-sm text-text-sub-600">
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
        <p className="text-paragraph-xs text-warning-base">
          Refresh failed. Showing the last provider-connection snapshot.
        </p>
      ) : null}
      {mounted ? (
        <p className="text-paragraph-xs text-text-soft-400">
          Updates refresh from the org event stream when provider-connection invalidations are
          present; save and revoke actions also reload this panel immediately.
        </p>
      ) : null}
    </div>
  );
}
