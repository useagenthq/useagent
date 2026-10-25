"use client";

import { RiPlugLine } from "@remixicon/react";
import { useCallback, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { CodexChatGptPath } from "./codex-chatgpt-path";
import { ConnectionStatusChip } from "./connection-status-chip";
import { revokeProviderConnection } from "./provider-connections-api";
import {
  accountLabel,
  connectionBadgeStatus,
  isActiveConnection,
  PROVIDER_LABELS,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMeta,
  type ProviderConnectionProvider,
  providerStatusConnection,
  rejectedKeyNotice,
  statusLabel,
} from "./provider-connections-data";
import { ProviderKeyForm } from "./provider-key-form";
import { relativeTime } from "@/utils/format";

const MASK = "••••••••";

function StatusPill({
  connection,
  deploymentProvided = false,
}: {
  connection: ProviderConnectionMeta | null;
  deploymentProvided?: boolean;
}) {
  // No org connection of its own, but the server's key serves this provider:
  // the product works, so say who is providing it rather than "Not connected".
  if (deploymentProvided && !isActiveConnection(connection)) {
    return <ConnectionStatusChip status="completed">Provided by this deployment</ConnectionStatusChip>;
  }
  const revoked = connection?.status === "revoked";
  return (
    <ConnectionStatusChip
      status={connectionBadgeStatus(connection)}
      dotClassName={revoked ? "bg-red-500" : undefined}
    >
      {statusLabel(connection)}
    </ConnectionStatusChip>
  );
}

/**
 * One provider section: a single bordered container whose contents are FLAT
 * rows divided by hairlines - header, auth-path rows, and the save form. The
 * previous card-in-card-in-card nesting collapsed into this one level.
 */
export function ProviderConnectionPanel({
  provider,
  connection,
  oauthConnection,
  codexSandboxExecutionEnabled,
  deploymentProvided = false,
  onSaved,
}: {
  provider: ProviderConnectionProvider;
  connection: ProviderConnectionMeta | null;
  oauthConnection: ProviderConnectionMeta | null;
  codexSandboxExecutionEnabled: boolean | null;
  /** The server's own key serves this provider, so runs work without an org key. */
  deploymentProvided?: boolean;
  onSaved: () => Promise<void>;
}) {
  const labels = PROVIDER_LABELS[provider];
  const [revoking, setRevoking] = useState<ProviderConnectionAuthMethod | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const revoke = useCallback(
    async (authMethod: ProviderConnectionAuthMethod) => {
      setRevoking(authMethod);
      setRevokeError(null);
      try {
        await revokeProviderConnection({ provider, authMethod });
        await onSaved();
      } catch {
        setRevokeError(`Couldn't revoke the ${labels.name} connection.`);
      } finally {
        setRevoking(null);
      }
    },
    [labels.name, onSaved, provider],
  );

  const keyActive = isActiveConnection(connection);
  const rejectedNotice = rejectedKeyNotice(connection, labels.name);

  return (
    <section className="rounded-xl border border-border-button-default bg-background-secondary-default px-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 border-b border-separator-border py-3">
        <div className="flex min-w-0 items-center gap-2">
          <RiPlugLine aria-hidden className="size-4 shrink-0 text-foreground-icon-tertiary" />
          <h3 className="truncate text-body-medium text-text-primary">{labels.name}</h3>
          <span className="truncate text-caption-1-regular text-text-tertiary">
            {labels.scope}
          </span>
        </div>
        <StatusPill
          connection={providerStatusConnection(connection, oauthConnection)}
          deploymentProvided={deploymentProvided}
        />
      </div>
      {deploymentProvided && !isActiveConnection(providerStatusConnection(connection, oauthConnection)) && (
        <p className="border-b border-separator-border py-2 text-caption-1-regular text-text-tertiary">
          Runs use this deployment&rsquo;s {labels.name} key. Connect your own to bill your account instead.
        </p>
      )}

      {provider === "openai" ? (
        <CodexChatGptPath
          connection={oauthConnection}
          sandboxExecutionEnabled={codexSandboxExecutionEnabled}
          onChanged={onSaved}
        />
      ) : null}

      {/* API-key row */}
      <div className="flex flex-col gap-3 border-b border-separator-border py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body-2-medium text-text-primary">API key</p>
            <StatusPill connection={connection} />
          </div>
          <p className="mt-1 text-caption-1-regular text-text-tertiary">
            {labels.keyHint}. Write-only - never shown again.
          </p>
          {rejectedNotice ? (
            <p className="mt-1 text-caption-1-regular text-text-error-primary">{rejectedNotice}</p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-caption-1-regular text-text-secondary">
            <span className="truncate">{accountLabel(connection)}</span>
            {connection ? (
              <>
                <span className="text-text-tertiary">·</span>
                <span>Updated {relativeTime(connection.updatedAt)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {keyActive ? (
            <span className="select-none font-mono text-caption-1-regular text-text-tertiary">
              {MASK}
              <span className="sr-only"> stored write-only credential</span>
            </span>
          ) : null}
          <Button
            variant={keyActive ? "danger" : "secondary"}
            size="xs"
            className="rounded-full"
            disabled={!keyActive || revoking === "api_key"}
            onClick={() => void revoke("api_key")}
          >
            Revoke
          </Button>
        </div>
      </div>

      {/* Save-key row */}
      <ProviderKeyForm provider={provider} connection={connection} onSaved={onSaved} />
      {revokeError ? (
        <p className="pb-3 text-caption-1-regular text-text-error-primary">{revokeError}</p>
      ) : null}
    </section>
  );
}

