"use client";

import {
  RiExternalLinkLine,
  RiFileCopyLine,
  RiLoader4Line,
} from "@remixicon/react";
import * as Button from "@/components/ui/button";
import * as StatusBadge from "@/components/ui/status-badge";
import {
  codexAccountLabel,
  codexAuthStatusLabel,
  codexLoginUrl,
  isActiveConnection,
  type ProviderConnectionMeta,
} from "./provider-connections-data";
import { relTime } from "./relative-time";
import { useCodexChatGptConnection } from "./use-codex-chatgpt-connection";

export function CodexChatGptPath({
  connection,
  sandboxExecutionEnabled,
  onChanged,
}: {
  connection: ProviderConnectionMeta | null;
  sandboxExecutionEnabled: boolean | null;
  onChanged: () => Promise<void>;
}) {
  const {
    busy,
    cancelLogin,
    copied,
    copyDeviceCode,
    error,
    login,
    refreshStatus,
    revokeLogin,
    startLogin,
    status,
  } = useCodexChatGptConnection(onChanged);
  const active = isActiveConnection(connection) || status?.account?.authMode === "chatgpt";
  const loginUrl = codexLoginUrl(login);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-label-sm text-text-strong-950">ChatGPT account connection</p>
            <StatusBadge.Root
              variant="light"
              status={
                active ? "completed" : connection?.status === "revoked" ? "disabled" : "pending"
              }
            >
              <StatusBadge.Dot />
              {codexAuthStatusLabel(status, connection)}
            </StatusBadge.Root>
          </div>
          <p className="mt-1 text-paragraph-xs text-text-soft-400">
            Account lifecycle only. The contained backend broker can sign in, read account status,
            and log out. It does not run Codex turns on the host or send subscription credentials
            into sandboxes.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-paragraph-xs text-text-sub-600">
            <span className="truncate">{codexAccountLabel(status, connection)}</span>
            {connection ? (
              <>
                <span className="text-text-soft-400">·</span>
                <span>Updated {relTime(connection.updatedAt)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button.Root
            type="button"
            variant="neutral"
            mode="stroke"
            size="xsmall"
            className="rounded-full"
            disabled={busy !== null}
            onClick={() => void startLogin("chatgpt")}
          >
            {busy === "browser" ? (
              <Button.Icon as={RiLoader4Line} className="animate-spin" />
            ) : null}
            Connect with ChatGPT
          </Button.Root>
          <Button.Root
            type="button"
            variant="neutral"
            mode="stroke"
            size="xsmall"
            className="rounded-full"
            disabled={busy !== null}
            onClick={() => void startLogin("device_code")}
          >
            {busy === "device" ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : null}
            Device code
          </Button.Root>
          <Button.Root
            type="button"
            variant="error"
            mode="stroke"
            size="xsmall"
            className="rounded-full"
            disabled={!active || busy !== null}
            onClick={() => void revokeLogin()}
          >
            {busy === "revoke" ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : null}
            Log out
          </Button.Root>
        </div>
      </div>

      <div className="rounded-lg border border-stroke-soft-200 bg-bg-weak-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-label-sm text-text-strong-950">Codex sandbox execution</p>
          <StatusBadge.Root
            variant="light"
            status={
              sandboxExecutionEnabled === null
                ? "pending"
                : sandboxExecutionEnabled
                  ? "completed"
                  : "disabled"
            }
          >
            <StatusBadge.Dot />
            {sandboxExecutionEnabled === null
              ? "Status unavailable"
              : sandboxExecutionEnabled
                ? "Enabled"
                : "Not enabled"}
          </StatusBadge.Root>
        </div>
        <p className="mt-1 text-paragraph-xs text-text-sub-600">
          {sandboxExecutionEnabled
            ? "Codex runs execute inside the sandbox through its provider gateway credential, not through this ChatGPT account."
            : "Connecting this ChatGPT account does not enable sandbox execution. Codex must be enabled independently by the runtime configuration."}
        </p>
      </div>

      {login ? (
        <div
          className="rounded-lg border border-stroke-soft-200 bg-bg-weak-50 p-3"
          aria-live="polite"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-label-sm text-text-strong-950">Login pending</p>
              <p className="mt-1 text-paragraph-xs text-text-sub-600">
                Complete the trusted login, then this panel will refresh automatically.
              </p>
              {login.type === "chatgptDeviceCode" ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-bg-white-0 px-2 py-1 font-mono text-label-sm text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
                    {login.userCode}
                  </span>
                  <Button.Root
                    type="button"
                    variant="neutral"
                    mode="stroke"
                    size="xsmall"
                    className="rounded-full"
                    onClick={() => void copyDeviceCode()}
                  >
                    <Button.Icon as={RiFileCopyLine} />
                    {copied ? "Copied" : "Copy"}
                  </Button.Root>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {loginUrl ? (
                <Button.Root
                  asChild
                  variant="neutral"
                  mode="filled"
                  size="xsmall"
                  className="rounded-full"
                >
                  <a href={loginUrl} target="_blank" rel="noreferrer">
                    <Button.Icon as={RiExternalLinkLine} />
                    Open login
                  </a>
                </Button.Root>
              ) : null}
              <Button.Root
                type="button"
                variant="neutral"
                mode="stroke"
                size="xsmall"
                className="rounded-full"
                disabled={busy !== null}
                onClick={() => void refreshStatus()}
              >
                {busy === "status" ? (
                  <Button.Icon as={RiLoader4Line} className="animate-spin" />
                ) : null}
                Check
              </Button.Root>
              <Button.Root
                type="button"
                variant="error"
                mode="stroke"
                size="xsmall"
                className="rounded-full"
                disabled={busy !== null}
                onClick={() => void cancelLogin()}
              >
                {busy === "cancel" ? (
                  <Button.Icon as={RiLoader4Line} className="animate-spin" />
                ) : null}
                Cancel
              </Button.Root>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-paragraph-xs text-error-base" role="status" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}
