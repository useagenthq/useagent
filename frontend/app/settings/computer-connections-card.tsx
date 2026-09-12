"use client";

import {
  RiCloudLine,
  RiKey2Line,
  RiLoader4Line,
  RiRefreshLine,
  RiStackLine,
} from "@remixicon/react";
import type { ComputerProviderConnectionProvider } from "@useagent/agent-client/provider-connections";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { cx } from "@/utils/cx";
import { ConnectionStatusChip, SpinnerIcon } from "./connection-status-chip";
import { fetchSandboxConfig, putProviderApiKey, revokeProviderConnection, type SandboxConfig } from "./provider-connections-api";
import {
  computerFooterCopy,
  connectionBadgeStatus,
  isActiveConnection,
  safeComputerMetadata,
  statusLabel,
} from "./provider-connections-data";
import { relTime } from "./relative-time";
import { useProviderConnections } from "./use-provider-connections";

const MASK = "••••••••";

/** Copy per computer provider; the form and the wire contract are shared. */
const COMPUTERS: Record<
  ComputerProviderConnectionProvider,
  {
    name: string;
    tagline: string;
    keyPlaceholder: string;
    snapshotLabel: string;
    snapshotPlaceholder: string;
    snapshotHint: string;
    snapshotRequired: boolean;
    keyHint: string;
  }
> = {
  daytona: {
    name: "Daytona",
    tagline: "Your API key and snapshot",
    keyPlaceholder: "Enter your Daytona API key",
    snapshotLabel: "Snapshot name",
    snapshotPlaceholder: "useagent-runtime-v17",
    snapshotHint: "Validated against Daytona without creating a sandbox.",
    snapshotRequired: true,
    keyHint: "Write-only and encrypted. Enter it again when changing the snapshot.",
  },
  box: {
    name: "Box",
    tagline: "Your API key and optional snapshot",
    keyPlaceholder: "Enter your Box API key",
    snapshotLabel: "Snapshot (optional)",
    snapshotPlaceholder: "useagent-runtime",
    snapshotHint: "Leave empty to start boxes from the base image. Validated without creating a box.",
    snapshotRequired: false,
    keyHint: "Write-only and encrypted. Enter it again when changing the snapshot.",
  },
};

function ComputerSection({
  provider,
  userComputers,
}: {
  provider: ComputerProviderConnectionProvider;
  userComputers: boolean | null;
}) {
  const copy = COMPUTERS[provider];
  const { connections, load, loading, refreshing } = useProviderConnections();
  const connection = useMemo(
    () => connections.find((item) => item.provider === provider && item.authMethod === "api_key") ?? null,
    [connections, provider],
  );
  const connected = isActiveConnection(connection);
  const [apiKey, setApiKey] = useState("");
  const [snapshotName, setSnapshotName] = useState("");
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSnapshotName(connection?.metadata.snapshotName ?? "");
  }, [connection?.metadata.snapshotName]);

  const metadata = safeComputerMetadata(provider, { snapshotName });

  const save = useCallback(async () => {
    const nextMetadata = safeComputerMetadata(provider, { snapshotName });
    if (!nextMetadata) return;
    const key = apiKey.trim();
    if (!key) return;
    setSaving(true);
    setKeyError(null);
    try {
      await putProviderApiKey({ provider, apiKey: key, metadata: nextMetadata });
      setApiKey("");
      await load();
    } catch {
      setKeyError(
        copy.snapshotRequired
          ? `Couldn't validate the ${copy.name} key and snapshot. Check both values and retry.`
          : `Couldn't validate the ${copy.name} key${snapshotName.trim() ? " and snapshot" : ""}. Check the value and retry.`,
      );
      keyInputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [apiKey, copy, load, provider, snapshotName]);

  const revoke = useCallback(async () => {
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeProviderConnection({ provider, authMethod: "api_key" });
      setApiKey("");
      await load();
    } catch {
      setRevokeError(`Couldn't revoke the ${copy.name} connection.`);
    } finally {
      setRevoking(false);
    }
  }, [copy.name, load, provider]);

  const keyId = `${provider}-api-key`;
  const keyErrorId = `${provider}-api-key-error`;
  const snapshotId = `${provider}-snapshot`;

  return (
    <section className="rounded-xl border border-border-button-default bg-background-secondary-default px-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-separator-border py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <RiStackLine aria-hidden className="size-4 shrink-0 text-foreground-icon-tertiary" />
          <h3 className="text-body-medium text-text-primary">{copy.name}</h3>
          <span className="text-caption-1-regular text-text-tertiary">{copy.tagline}</span>
        </div>
        <div className="flex items-center gap-2">
          <ConnectionStatusChip status={connectionBadgeStatus(connection)}>{statusLabel(connection)}</ConnectionStatusChip>
          <Button
            variant="secondary"
            size="xs"
            className="rounded-full"
            aria-label={`Refresh ${copy.name} connection`}
            disabled={refreshing}
            onClick={() => void load()}
            leadingIcon={(props) => <RiRefreshLine {...props} className={cx(props.className, refreshing && "animate-spin")} />}
          >
            Refresh
          </Button>
        </div>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-5 text-body-2-regular text-text-secondary">
          <RiLoader4Line aria-hidden className="size-4 animate-spin" />
          Loading {copy.name} connection...
        </div>
      ) : (
        <form
          className="flex flex-col gap-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-caption-1-medium text-text-secondary" htmlFor={keyId}>
                API key
              </label>
              <InputBase
                ref={keyInputRef}
                id={keyId}
                aria-label={`${copy.name} API key`}
                aria-invalid={keyError ? true : undefined}
                aria-describedby={keyError ? keyErrorId : undefined}
                placeholder={connected ? MASK : copy.keyPlaceholder}
                type="password"
                autoComplete="off"
                spellCheck={false}
                leadingIcon={RiKey2Line}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              {keyError ? (
                <p id={keyErrorId} role="alert" className="mt-1 text-caption-1-regular text-text-error-primary">
                  {keyError}
                </p>
              ) : (
                <p className="mt-1 text-caption-1-regular text-text-tertiary">{copy.keyHint}</p>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-caption-1-medium text-text-secondary" htmlFor={snapshotId}>
                {copy.snapshotLabel}
              </label>
              <InputBase
                id={snapshotId}
                aria-label={`${copy.name} snapshot name`}
                placeholder={copy.snapshotPlaceholder}
                autoComplete="off"
                spellCheck={false}
                value={snapshotName}
                onChange={(event) => setSnapshotName(event.target.value)}
              />
              <p className="mt-1 text-caption-1-regular text-text-tertiary">{copy.snapshotHint}</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t border-separator-border pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-caption-1-regular text-text-tertiary">
              {computerFooterCopy(copy.name, userComputers, connected)}
            </p>
            <div className="flex items-center gap-2">
              {connection ? (
                <span className="text-caption-1-regular text-text-tertiary">Updated {relTime(connection.updatedAt)}</span>
              ) : null}
              {connected ? (
                <Button
                  type="button"
                  variant="danger"
                  size="xs"
                  className="rounded-full"
                  disabled={revoking}
                  onClick={() => void revoke()}
                >
                  Revoke
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="secondary"
                size="small"
                className="rounded-full"
                disabled={!metadata || apiKey.trim().length === 0 || saving}
                leadingIcon={saving ? SpinnerIcon : undefined}
              >
                {connected ? `Update ${copy.name}` : `Connect ${copy.name}`}
              </Button>
            </div>
          </div>
          {revokeError ? (
            <p role="alert" className="text-caption-1-regular text-text-error-primary">
              {revokeError}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}

/**
 * Computer providers: the managed runtime the server runs today, then each
 * bring-your-own provider with the same write-only key + snapshot form.
 */
export function ComputerConnectionsCard() {
  const { connections, error, load } = useProviderConnections();
  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchSandboxConfig()
      .then((config) => {
        if (!cancelled) setSandboxConfig(config);
      })
      .catch(() => {
        if (!cancelled) setSandboxConfig({ provider: null, userComputers: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const userComputers = sandboxConfig ? sandboxConfig.userComputers : null;
  if (error && connections.length === 0) {
    return <BackendUnreachable onRetry={() => void load()} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border-button-default bg-background-secondary-default px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <RiCloudLine aria-hidden className="size-5 shrink-0 text-foreground-icon-tertiary" />
          <div className="min-w-0">
            <p className="text-body-2-medium text-text-primary">
              {sandboxConfig?.provider === "box" ? "Managed Box" : sandboxConfig?.provider === "daytona" ? "Managed Daytona" : "Managed Cube"}
            </p>
            <p className="text-caption-1-regular text-text-tertiary">
              The server's computer provider, used unless a personal one runs your work.
            </p>
          </div>
        </div>
        <ConnectionStatusChip status="completed">Available</ConnectionStatusChip>
      </div>
      <ComputerSection provider="daytona" userComputers={userComputers} />
      <ComputerSection provider="box" userComputers={userComputers} />
    </div>
  );
}
