"use client";

import { RiKey2Line, RiLoader4Line, RiPlugLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/ui/button";
import * as Input from "@/components/ui/input";
import * as StatusBadge from "@/components/ui/status-badge";
import { CodexChatGptPath } from "./codex-chatgpt-path";
import { putProviderApiKey, revokeProviderConnection } from "./provider-connections-api";
import {
  accountLabel,
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
  const active = isActiveConnection(connection);
  const revoked = connection?.status === "revoked";
  return (
    <StatusBadge.Root
      variant="light"
      status={active ? "completed" : revoked ? "disabled" : "pending"}
    >
      <StatusBadge.Dot />
      {statusLabel(connection)}
    </StatusBadge.Root>
  );
}

function AuthPathRow({
  label,
  detail,
  connection,
  onRevoke,
  disabled,
}: {
  label: string;
  detail: string;
  connection: ProviderConnectionMeta | null;
  onRevoke: () => void;
  disabled: boolean;
}) {
  const active = isActiveConnection(connection);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-label-sm text-text-strong-950">{label}</p>
          <StatusPill connection={connection} />
        </div>
        <p className="mt-1 text-paragraph-xs text-text-soft-400">{detail}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-paragraph-xs text-text-sub-600">
          <span className="truncate">{accountLabel(connection)}</span>
          {connection ? (
            <>
              <span className="text-text-soft-400">·</span>
              <span>Updated {relTime(connection.updatedAt)}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {active ? (
          <span className="select-none font-mono text-paragraph-xs text-text-soft-400">
            {MASK}
            <span className="sr-only"> stored write-only credential</span>
          </span>
        ) : null}
        <Button.Root
          type="button"
          variant={active ? "error" : "neutral"}
          mode="stroke"
          size="xsmall"
          className="rounded-full"
          disabled={!active || disabled}
          onClick={onRevoke}
        >
          Revoke
        </Button.Root>
      </div>
    </div>
  );
}

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

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <RiPlugLine aria-hidden className="size-4 text-text-soft-400" />
            <h3 className="text-title-h6 text-text-strong-950">{labels.name}</h3>
          </div>
          <p className="mt-1 text-paragraph-xs text-text-sub-600">{labels.scope}</p>
        </div>
        <StatusPill connection={connection ?? oauthConnection} />
      </div>

      <div className="grid gap-3">
        {provider === "openai" ? (
          <CodexChatGptPath
            connection={oauthConnection}
            sandboxExecutionEnabled={codexSandboxExecutionEnabled}
            onChanged={onSaved}
          />
        ) : null}
        <AuthPathRow
          label="API key"
          detail={`${labels.keyHint}. Write-only: the saved value is never read back into the browser.`}
          connection={connection}
          disabled={revoking === "api_key"}
          onRevoke={() => void revoke("api_key")}
        />
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_auto]">
          <Input.Root>
            <Input.Wrapper>
              <Input.Icon as={RiKey2Line} />
              <Input.Input
                aria-label={`${labels.name} API key`}
                placeholder={labels.keyPlaceholder}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Input.Wrapper>
          </Input.Root>
          <Input.Root>
            <Input.Wrapper>
              <Input.Input
                aria-label={`${labels.name} account email`}
                placeholder="Account email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Input.Wrapper>
          </Input.Root>
          <Input.Root>
            <Input.Wrapper>
              <Input.Input
                aria-label={`${labels.name} plan or label`}
                placeholder="Plan or label"
                value={planType}
                onChange={(event) => setPlanType(event.target.value)}
              />
            </Input.Wrapper>
          </Input.Root>
          <Button.Root
            type="submit"
            variant="neutral"
            mode="stroke"
            size="small"
            className="rounded-full"
            disabled={apiKey.trim().length === 0 || saving}
          >
            {saving ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : null}
            Save key
          </Button.Root>
        </div>
        <p className="text-paragraph-xs text-text-soft-400">
          Account fields are labels only; they help identify the credential without exposing it.
        </p>
        {formError ? <p className="text-paragraph-xs text-error-base">{formError}</p> : null}
      </form>
    </section>
  );
}
