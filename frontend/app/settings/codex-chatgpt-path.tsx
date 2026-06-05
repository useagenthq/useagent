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

/**
 * The ChatGPT-subscription path for Codex, rendered as ROWS inside the
 * provider section (no nested cards): the connection row, an inline
 * login-pending row while a device-code flow is open, and a one-line note
 * only when sandbox execution is off.
 */
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
    <>
      <div className="flex flex-col gap-3 border-b border-separator-border py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body-2-medium text-text-primary">ChatGPT account</p>
            <ConnectionStatusChip
              status={codexAuthBadgeStatus(status, connection)}
              dotClassName={connection?.status === "revoked" ? "bg-red-500" : undefined}
            >
              {codexAuthStatusLabel(status, connection)}
            </ConnectionStatusChip>
          </div>
          <p className="mt-1 text-caption-1-regular text-text-tertiary">
            Run Codex on your ChatGPT subscription. Sign-in stays on the server;
            credentials never enter a sandbox.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-caption-1-regular text-text-secondary">
            <span className="truncate">{codexAccountLabel(status, connection)}</span>
            {connection ? (
              <>
                <span className="text-text-tertiary">·</span>
                <span>Updated {relTime(connection.updatedAt)}</span>
              </>
            ) : null}
          </div>
          {sandboxExecutionEnabled === false ? (
            <p className="mt-1 text-caption-1-regular text-status-yellow-text">
              Codex is not enabled on this deployment; connecting the account does
              not start runs by itself.
            </p>
          ) : null}
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

      {login ? (
        <div
          className="flex flex-col gap-3 border-b border-separator-border py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
          aria-live="polite"
        >
          <div className="min-w-0">
            <p className="text-body-2-medium text-text-primary">Login pending</p>
            <p className="mt-1 text-caption-1-regular text-text-secondary">
              Copy the code and finish sign-in on the OpenAI page. This panel
              refreshes automatically.
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
      ) : null}

      {error ? (
        <p
          className="border-b border-separator-border py-2 text-caption-1-regular text-text-error-primary last:border-b-0"
          role="status"
          aria-live="polite"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
