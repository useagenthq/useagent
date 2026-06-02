"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RiCheckLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiKey2Line,
  RiLoader4Line,
} from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import { InputBase, TextField } from "@/components/base/input/input";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { cx } from "@/utils/cx";
import { relTime } from "./relative-time";
import { createApiKey, fetchApiKeys, revokeApiKey } from "./api-keys-api";
import type { ApiKeyMeta, CreatedApiKey } from "./api-keys-data";

const COPIED_RESET_MS = 1000;
const MAX_NAME_LEN = 100;

/** Remix loader with the spin baked in, in Button `leadingIcon` shape. */
function SpinnerIcon({
  className,
  ...props
}: {
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  return <RiLoader4Line {...props} className={cx(className, "animate-spin")} />;
}

/**
 * API keys list + create form for Settings. A key is a long-lived bearer
 * credential for local-to-cloud run dispatch. The secret is shown EXACTLY once,
 * right after creation, with a copy affordance and a "store it now" note; the
 * list only ever shows the display prefix. Revoking is a soft delete (the row is
 * kept, marked revoked). Self-fetches on mount.
 */
export function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyMeta[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The one-time plaintext secret, held only until the user dismisses it.
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      setKeys(await fetchApiKeys());
      setError(false);
    } catch {
      // A connection problem, not "no keys" - surface the distinct error.
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const trimmedName = name.trim();
  const canCreate = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LEN && !creating;

  const create = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    setCreateError(null);
    try {
      const fresh = await createApiKey(trimmedName);
      // Reveal the secret once and add the new key's metadata to the list.
      setCreated(fresh);
      setCopied(false);
      const meta: ApiKeyMeta = {
        id: fresh.id,
        name: fresh.name,
        prefix: fresh.prefix,
        createdAt: fresh.createdAt,
        lastUsedAt: fresh.lastUsedAt,
        revokedAt: fresh.revokedAt,
      };
      setKeys((prev) => [meta, ...prev.filter((k) => k.id !== meta.id)]);
      setError(false);
      setName("");
    } catch {
      setCreateError("Couldn't create the key. Try again.");
    } finally {
      setCreating(false);
    }
  }, [canCreate, trimmedName]);

  const copySecret = useCallback(async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
    } catch {
      return; // clipboard blocked - leave the idle icon
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [created]);

  const revoke = useCallback(
    async (id: string) => {
      setConfirming(null);
      const prev = keys;
      // Optimistic: mark the row revoked; restore from the server if it fails.
      const nowIso = new Date().toISOString();
      setKeys((list) => list.map((k) => (k.id === id ? { ...k, revokedAt: nowIso } : k)));
      try {
        await revokeApiKey(id);
      } catch {
        setKeys(prev);
      }
    },
    [keys],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Create form */}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <TextField aria-label="API key name" value={name} onChange={setName}>
              <InputBase
                leadingIcon={RiKey2Line}
                placeholder="Key name (e.g. laptop-cli)"
                spellCheck={false}
                autoComplete="off"
              />
            </TextField>
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="small"
            leadingIcon={creating ? SpinnerIcon : undefined}
            disabled={!canCreate}
          >
            Create key
          </Button>
        </div>
        <p className="text-caption-1-regular text-text-tertiary">
          A key lets a local script dispatch and read runs for this workspace over the API. It
          cannot manage secrets, settings, or other keys.
        </p>
        {createError && (
          <p className="text-caption-1-regular text-text-error-primary">{createError}</p>
        )}
      </form>

      {/* One-time secret reveal */}
      {created && (
        <div className="flex flex-col gap-2 rounded-xl border border-border-button-default bg-background-secondary-default p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-body-2-medium text-text-primary">Copy your new key</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-background-primary-default px-2 py-1.5 font-mono text-caption-1-regular text-text-primary ring-1 ring-inset ring-border-button-default">
              {created.key}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="small"
              leadingIcon={copied ? RiCheckLine : RiFileCopyLine}
              onClick={() => void copySecret()}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-caption-1-regular text-text-error-primary">
            Store it now, it is not shown again.
          </p>
        </div>
      )}

      {/* List / empty / error */}
      {error && keys.length === 0 ? (
        <BackendUnreachable onRetry={refetch} />
      ) : loading && keys.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-body-2-regular text-text-secondary">
          <RiLoader4Line aria-hidden className="size-4 animate-spin" />
          Loading API keys...
        </div>
      ) : keys.length === 0 ? (
        <p className="py-6 text-body-2-regular text-text-secondary">
          No API keys yet. Create one above to dispatch runs from a local script.
        </p>
      ) : (
        <div className="flex flex-col">
          {keys.map((k) => {
            const revoked = k.revokedAt !== null;
            return (
              <div
                key={k.id}
                className="flex items-center gap-3 border-b border-separator-border py-2.5 last:border-b-0"
              >
                <RiKey2Line
                  aria-hidden
                  className={cx(
                    "size-4 shrink-0",
                    revoked ? "text-foreground-icon-disabled" : "text-foreground-icon-tertiary",
                  )}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cx(
                      "truncate text-body-2-medium",
                      revoked ? "text-text-tertiary line-through" : "text-text-primary",
                    )}
                  >
                    {k.name}
                  </span>
                  <span className="truncate font-mono text-caption-1-regular text-text-tertiary">
                    {k.prefix}...
                  </span>
                </div>
                {mounted && (
                  <span className="hidden text-caption-1-regular text-text-tertiary sm:inline">
                    {k.lastUsedAt ? `Used ${relTime(k.lastUsedAt)}` : "Never used"}
                  </span>
                )}
                {revoked ? (
                  <span className="shrink-0 rounded-full border border-border-button-default px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-text-tertiary">
                    Revoked
                  </span>
                ) : confirming === k.id ? (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="xs"
                      onClick={() => void revoke(k.id)}
                    >
                      Revoke
                    </Button>
                  </div>
                ) : (
                  <IconButton
                    type="button"
                    icon={RiDeleteBinLine}
                    size="small"
                    aria-label={`Revoke ${k.name}`}
                    onClick={() => setConfirming(k.id)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
