"use client";

import { RiKey2Line, RiPlugLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { CodexChatGptPath } from "./codex-chatgpt-path";
import { ConnectionStatusChip, SpinnerIcon } from "./connection-status-chip";
import { putProviderApiKey, revokeProviderConnection } from "./provider-connections-api";
import {
  accountLabel,
  connectionBadgeStatus,
  isActiveConnection,
  PROVIDER_LABELS,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMeta,
  type ProviderConnectionProvider,
  safeProviderMetadata,
  statusLabel,
} from "./provider-connections-data";
import { relTime } from "./relative-time";

const MASK = "••••••••";

function StatusPill({ connection }: { connection: ProviderConnectionMeta | null }) {
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
  onSaved,
}: {
  provider: ProviderConnectionProvider;
  connection: ProviderConnectionMeta | null;
  oauthConnection: ProviderConnectionMeta | null;
  codexSandboxExecutionEnabled: boolean | null;
  onSaved: () => Promise<void>;
}) {
  const labels = PROVIDER_LABELS[provider];
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [planType, setPlanType] = useState("");
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState<ProviderConnectionAuthMethod | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setEmail(connection?.metadata.email ?? "");
    setPlanType(connection?.metadata.planType ?? "");
  }, [connection?.metadata.email, connection?.metadata.planType]);

  const save = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSaving(true);
    setFormError(null);
    try {
      await putProviderApiKey({
        provider,
        apiKey: trimmed,
        metadata: safeProviderMetadata({ email, planType }),
      });
      setApiKey("");
      await onSaved();
    } catch {
      setFormError(`Couldn't save the ${labels.name} API key.`);
    } finally {
      setSaving(false);
    }
  }, [apiKey, email, labels.name, onSaved, planType, provider]);

  const revoke = useCallback(
    async (authMethod: ProviderConnectionAuthMethod) => {
      setRevoking(authMethod);
      setFormError(null);
      try {
        await revokeProviderConnection({ provider, authMethod });
        await onSaved();
      } catch {
        setFormError(`Couldn't revoke the ${labels.name} connection.`);
      } finally {
        setRevoking(null);
      }
    },
    [labels.name, onSaved, provider],
  );

  const keyActive = isActiveConnection(connection);

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
        <StatusPill connection={connection ?? oauthConnection} />
      </div>

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
          <div className="mt-1 flex flex-wrap items-center gap-2 text-caption-1-regular text-text-secondary">
            <span className="truncate">{accountLabel(connection)}</span>
            {connection ? (
              <>
                <span className="text-text-tertiary">·</span>
                <span>Updated {relTime(connection.updatedAt)}</span>
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
      <form
        className="flex flex-col gap-2 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_auto]">
          <InputBase
            aria-label={`${labels.name} API key`}
            placeholder={labels.keyPlaceholder}
            type="password"
            autoComplete="off"
            spellCheck={false}
            leadingIcon={RiKey2Line}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <InputBase
            aria-label={`${labels.name} account email`}
            placeholder="Account email (optional)"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <InputBase
            aria-label={`${labels.name} plan or label`}
            placeholder="Label (optional)"
            value={planType}
            onChange={(event) => setPlanType(event.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="small"
            className="rounded-full"
            disabled={apiKey.trim().length === 0 || saving}
            leadingIcon={saving ? SpinnerIcon : undefined}
          >
            Save key
          </Button>
        </div>
        {formError ? (
          <p className="text-caption-1-regular text-text-error-primary">{formError}</p>
        ) : null}
      </form>
    </section>
  );
}
