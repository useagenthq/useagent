"use client";

import {
  RiCloudLine,
  RiKey2Line,
  RiLoader4Line,
  RiRefreshLine,
  RiStackLine,
} from "@remixicon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { cx } from "@/utils/cx";
import { ConnectionStatusChip, SpinnerIcon } from "./connection-status-chip";
import { putProviderApiKey, revokeProviderConnection } from "./provider-connections-api";
import {
  connectionBadgeStatus,
  isActiveConnection,
  safeDaytonaMetadata,
  statusLabel,
} from "./provider-connections-data";
import { relTime } from "./relative-time";
import { useProviderConnections } from "./use-provider-connections";

const MASK = "••••••••";

export function DaytonaConnectionCard() {
  const { connections, error, load, loading, refreshing } = useProviderConnections();
  const connection = useMemo(
    () =>
      connections.find((item) => item.provider === "daytona" && item.authMethod === "api_key") ??
      null,
    [connections],
  );
  const connected = isActiveConnection(connection);
  const [apiKey, setApiKey] = useState("");
  const [snapshotName, setSnapshotName] = useState("");
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setSnapshotName(connection?.metadata.snapshotName ?? "");
  }, [connection?.metadata.snapshotName]);

  const metadata = safeDaytonaMetadata({ snapshotName });
  const save = useCallback(async () => {
    const nextMetadata = safeDaytonaMetadata({ snapshotName });
    if (!nextMetadata) return;
    const key = apiKey.trim();
    if (!key) return;
    setSaving(true);
    setFormError(null);
    try {
      await putProviderApiKey({ provider: "daytona", apiKey: key, metadata: nextMetadata });
      setApiKey("");
      await load();
    } catch {
      setFormError("Couldn't validate the Daytona key and snapshot. Check both values and retry.");
    } finally {
      setSaving(false);
    }
  }, [apiKey, load, snapshotName]);

  const revoke = useCallback(async () => {
    setRevoking(true);
    setFormError(null);
    try {
      await revokeProviderConnection({ provider: "daytona", authMethod: "api_key" });
      setApiKey("");
      await load();
    } catch {
      setFormError("Couldn't revoke the Daytona connection.");
    } finally {
      setRevoking(false);
    }
  }, [load]);

  if (error && connections.length === 0) {
    return <BackendUnreachable onRetry={() => void load()} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border-button-default bg-background-secondary-default px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <RiCloudLine aria-hidden className="size-5 shrink-0 text-foreground-icon-tertiary" />
          <div className="min-w-0">
            <p className="text-body-2-medium text-text-primary">Managed Cube</p>
            <p className="text-caption-1-regular text-text-tertiary">
              Hosted sandbox runtime currently used for agent execution.
            </p>
          </div>
        </div>
        <ConnectionStatusChip status="completed">Available</ConnectionStatusChip>
      </div>

      <section className="rounded-xl border border-border-button-default bg-background-secondary-default px-4">
        <div className="flex items-center justify-between gap-3 border-b border-separator-border py-3">
          <div className="flex min-w-0 items-center gap-2">
            <RiStackLine aria-hidden className="size-4 shrink-0 text-foreground-icon-tertiary" />
            <h3 className="text-body-medium text-text-primary">Daytona</h3>
            <span className="truncate text-caption-1-regular text-text-tertiary">
              Your API key and snapshot
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionStatusChip status={connectionBadgeStatus(connection)}>
              {statusLabel(connection)}
            </ConnectionStatusChip>
            <Button
              variant="secondary"
              size="xs"
              className="rounded-full"
              aria-label="Refresh Daytona connection"
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
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-5 text-body-2-regular text-text-secondary">
            <RiLoader4Line aria-hidden className="size-4 animate-spin" />
            Loading Daytona connection...
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
                <label
                  className="mb-1.5 block text-caption-1-medium text-text-secondary"
                  htmlFor="daytona-api-key"
                >
                  API key
                </label>
                <InputBase
                  id="daytona-api-key"
                  aria-label="Daytona API key"
                  placeholder={connected ? MASK : "Enter your Daytona API key"}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  leadingIcon={RiKey2Line}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <p className="mt-1 text-caption-1-regular text-text-tertiary">
                  Write-only and encrypted. Enter it again when changing the snapshot.
                </p>
              </div>
              <div>
                <label
                  className="mb-1.5 block text-caption-1-medium text-text-secondary"
                  htmlFor="daytona-snapshot"
                >
                  Snapshot name
                </label>
                <InputBase
                  id="daytona-snapshot"
                  aria-label="Daytona snapshot name"
                  placeholder="useagent-runtime-v17"
                  autoComplete="off"
                  spellCheck={false}
                  value={snapshotName}
                  onChange={(event) => setSnapshotName(event.target.value)}
                />
                <p className="mt-1 text-caption-1-regular text-text-tertiary">
                  Validated against Daytona without creating a sandbox.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-separator-border pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-caption-1-regular text-text-tertiary">
                Connection setup is available now. Personal Daytona execution remains rollout-gated.
              </p>
              <div className="flex items-center gap-2">
                {connection ? (
                  <span className="text-caption-1-regular text-text-tertiary">
                    Updated {relTime(connection.updatedAt)}
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="danger"
                  size="xs"
                  className="rounded-full"
                  disabled={!connected || revoking}
                  onClick={() => void revoke()}
                >
                  Revoke
                </Button>
                <Button
                  type="submit"
                  variant="secondary"
                  size="small"
                  className="rounded-full"
                  disabled={!metadata || apiKey.trim().length === 0 || saving}
                  leadingIcon={saving ? SpinnerIcon : undefined}
                >
                  {connected ? "Update Daytona" : "Connect Daytona"}
                </Button>
              </div>
            </div>
            {formError ? (
              <p className="text-caption-1-regular text-text-error-primary">{formError}</p>
            ) : null}
          </form>
        )}
      </section>
    </div>
  );
}
