"use client";

import { RiExternalLinkLine, RiFileCopyLine } from "@remixicon/react";
import { Button, ButtonLink } from "@/components/base/buttons/button";
import { ConnectionStatusChip, SpinnerIcon } from "./connection-status-chip";
import {
  codexAccountLabel,
  codexAuthBadgeStatus,
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
    <div className="flex flex-col gap-3 rounded-xl border border-border-button-default bg-background-primary-default p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body-2-medium text-text-primary">ChatGPT account connection</p>
            <ConnectionStatusChip
              status={codexAuthBadgeStatus(status, connection)}
              dotClassName={connection?.status === "revoked" ? "bg-red-500" : undefined}
            >
              {codexAuthStatusLabel(status, connection)}
            </ConnectionStatusChip>
          </div>
          <p className="mt-1 text-caption-1-regular text-text-tertiary">
            Account lifecycle only. The contained backend broker can sign in, read account status,
            and log out. It does not run Codex turns on the host or send subscription credentials
            into sandboxes.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-caption-1-regular text-text-secondary">
            <span className="truncate">{codexAccountLabel(status, connection)}</span>
            {connection ? (
              <>
                <span className="text-text-tertiary">·</span>
                <span>Updated {relTime(connection.updatedAt)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="xs"
            className="rounded-full"
            disabled={busy !== null}
            onClick={() => void startLogin()}
            leadingIcon={busy === "connect" ? SpinnerIcon : undefined}
          >
            Connect with ChatGPT
          </Button>
          <Button
            variant="danger"
            size="xs"
            className="rounded-full"
            disabled={!active || busy !== null}
            onClick={() => void revokeLogin()}
            leadingIcon={busy === "revoke" ? SpinnerIcon : undefined}
          >
            Log out
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border-button-default bg-background-secondary-default p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-body-2-medium text-text-primary">Codex sandbox execution</p>
          <ConnectionStatusChip status={sandboxExecutionEnabled ? "completed" : "disabled"}>
            {sandboxExecutionEnabled === null
              ? "Status unavailable"
              : sandboxExecutionEnabled
                ? "Enabled"
                : "Not enabled"}
          </ConnectionStatusChip>
        </div>
        <p className="mt-1 text-caption-1-regular text-text-secondary">
          {sandboxExecutionEnabled
            ? "Codex runs execute inside the sandbox through its provider gateway credential, not through this ChatGPT account."
            : "Connecting this ChatGPT account does not enable sandbox execution. Codex must be enabled independently by the runtime configuration."}
        </p>
      </div>

      {login ? (
        <div
          className="rounded-lg border border-border-button-default bg-background-secondary-default p-3"
          aria-live="polite"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-body-2-medium text-text-primary">Login pending</p>
              <p className="mt-1 text-caption-1-regular text-text-secondary">
                Copy the code, open the trusted OpenAI page, and complete sign-in. This panel will
                refresh automatically.
              </p>
              {login.type === "chatgptDeviceCode" ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-background-primary-default px-2 py-1 font-mono text-body-2-medium text-text-primary ring-1 ring-inset ring-border-button-default">
                    {login.userCode}
                  </span>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="rounded-full"
                    onClick={() => void copyDeviceCode()}
                    leadingIcon={RiFileCopyLine}
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {loginUrl ? (
                <ButtonLink
                  variant="primary"
                  size="xs"
                  className="rounded-full"
                  href={loginUrl}
                  target="_blank"
                  rel="noreferrer"
                  leadingIcon={RiExternalLinkLine}
                >
                  Open login
                </ButtonLink>
              ) : null}
              <Button
                variant="secondary"
                size="xs"
                className="rounded-full"
                disabled={busy !== null}
                onClick={() => void refreshStatus()}
                leadingIcon={busy === "status" ? SpinnerIcon : undefined}
              >
                Check
              </Button>
              <Button
                variant="danger"
                size="xs"
                className="rounded-full"
                disabled={busy !== null}
                onClick={() => void cancelLogin()}
                leadingIcon={busy === "cancel" ? SpinnerIcon : undefined}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-caption-1-regular text-text-error-primary" role="status" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}
