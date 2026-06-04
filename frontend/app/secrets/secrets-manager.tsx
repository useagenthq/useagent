"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RiDeleteBinLine,
  RiKey2Line,
  RiLoader4Line,
} from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import { InputBase, TextField } from "@/components/base/input/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { REVEAL_ON_HOVER } from "@/components/customize/list-row";
import { cx } from "@/utils/cx";
import { relTime } from "@/app/settings/relative-time";
import { deleteSecret, fetchSecrets, putSecret } from "./secrets-api";
import { isValidSecretName, SECRET_KINDS, type SecretKind, type SecretMeta } from "./secrets-data";

const MASK = "••••••••";

function byName(a: SecretMeta, b: SecretMeta): number {
  return a.name.localeCompare(b.name);
}

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
 * The Secrets list + add/update form. Reused by the /secrets page (seeded with
 * SSR data via `initial`) and the Settings > Secrets section (no seed → it
 * self-fetches on mount). Values are write-only: the list shows names + a static
 * mask, never a value, and the value input clears after every successful save.
 */
export function SecretsManager({
  initial = null,
  initialError = false,
}: {
  initial?: SecretMeta[] | null;
  initialError?: boolean;
}) {
  const [secrets, setSecrets] = useState<SecretMeta[]>(initial ?? []);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(initial === null && !initialError);
  const [mounted, setMounted] = useState(false);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<SecretKind>("env");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await fetchSecrets();
      setSecrets(fresh.slice().sort(byName));
      setError(false);
    } catch {
      // A connection problem, not "no secrets" — surface the distinct error.
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Self-fetch only when the caller passed no SSR seed (the Settings usage).
  useEffect(() => {
    if (initial === null && !initialError) void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length > 0 && !isValidSecretName(trimmedName);
  const exists = useMemo(
    () => secrets.some((s) => s.name === trimmedName),
    [secrets, trimmedName],
  );
  const canSave = isValidSecretName(trimmedName) && value.length > 0 && !saving;

  const save = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const meta = await putSecret(trimmedName, value, kind);
      setSecrets((prev) => {
        const without = prev.filter((s) => s.name !== meta.name);
        return [...without, meta].sort(byName);
      });
      setError(false);
      // The value never round-trips back; clear the form after a save.
      setName("");
      setValue("");
    } catch {
      setSaveError("Couldn't save the secret. Check the name and try again.");
    } finally {
      setSaving(false);
    }
  }, [canSave, trimmedName, value, kind]);

  const remove = useCallback(async (target: string) => {
    setConfirming(null);
    const prev = secrets;
    // Optimistic removal; restore the row if the delete fails.
    setSecrets((list) => list.filter((s) => s.name !== target));
    try {
      await deleteSecret(target);
    } catch {
      setSecrets(prev);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secrets]);

  return (
    <div className="flex flex-col gap-5">
      {/* Add / update form */}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="sm:w-[260px]">
            <TextField
              aria-label="Secret name"
              isInvalid={nameInvalid}
              value={name}
              onChange={setName}
            >
              <InputBase
                leadingIcon={RiKey2Line}
                placeholder="SECRET_NAME"
                spellCheck={false}
                autoCapitalize="characters"
                className="font-mono"
              />
            </TextField>
          </div>
          <div className="min-w-0 flex-1">
            <TextField
              aria-label="Secret value"
              type="password"
              value={value}
              onChange={setValue}
            >
              <InputBase placeholder="Value (write-only)" autoComplete="off" />
            </TextField>
          </div>
          {/* Kind toggle: env var vs materialized file. */}
          <SegmentedControl
            aria-label="Secret kind"
            className="shrink-0"
            selectedKeys={[kind]}
            onSelectionChange={(keys) => {
              const next = [...(keys as Set<string>)][0];
              if (next) setKind(next as SecretKind);
            }}
          >
            {SECRET_KINDS.map((k) => (
              <SegmentedControlItem key={k} id={k} className="capitalize">
                {k}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <Button
            type="submit"
            variant="secondary"
            size="small"
            leadingIcon={saving ? SpinnerIcon : undefined}
            disabled={!canSave}
          >
            {exists ? "Update" : "Add secret"}
          </Button>
        </div>
        {nameInvalid ? (
          <p className="text-caption-1-regular text-text-error-primary">
            Use an env-var name: an uppercase letter, then uppercase letters, digits, or underscores (e.g. GCP_SA_KEY).
          </p>
        ) : kind === "file" ? (
          <p className="text-caption-1-regular text-text-tertiary">
            Written to a 0600 file in every sandbox this workspace boots; the env var holds its path.
          </p>
        ) : (
          <p className="text-caption-1-regular text-text-tertiary">
            Injected as an environment variable into every sandbox this workspace boots.
          </p>
        )}
        {saveError && <p className="text-caption-1-regular text-text-error-primary">{saveError}</p>}
      </form>

      {/* List / empty / error */}
      {error && secrets.length === 0 ? (
        <BackendUnreachable onRetry={refetch} />
      ) : loading && secrets.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-body-2-regular text-text-secondary">
          <RiLoader4Line aria-hidden className="size-4 animate-spin" />
          Loading secrets...
        </div>
      ) : secrets.length === 0 ? (
        <p className="py-6 text-body-2-regular text-text-secondary">
          No secrets yet. Add one above to inject it into every sandbox this workspace boots.
        </p>
      ) : (
        <div className="flex flex-col">
          {secrets.map((s) => (
            <div
              key={s.name}
              className="group/customize flex items-center gap-3 border-b border-separator-border py-2.5 last:border-b-0"
            >
              <RiKey2Line aria-hidden className="size-4 shrink-0 text-foreground-icon-tertiary" />
              <span className="min-w-0 flex-1 truncate font-mono text-body-2-medium text-text-primary">
                {s.name}
              </span>
              {s.kind === "file" && (
                <span className="shrink-0 rounded-full border border-border-button-default px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-text-tertiary">
                  file
                </span>
              )}
              <span
                className="hidden select-none font-mono text-caption-1-regular text-text-secondary sm:inline"
                aria-hidden
              >
                {MASK}
              </span>
              {mounted && (
                <span className="hidden text-caption-1-regular text-text-tertiary sm:inline">
                  Updated {relTime(s.updatedAt)}
                </span>
              )}
              {confirming === s.name ? (
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
                    onClick={() => void remove(s.name)}
                  >
                    Delete
                  </Button>
                </div>
              ) : (
                <span className={cx("inline-flex shrink-0", REVEAL_ON_HOVER)}>
                  <IconButton
                    type="button"
                    icon={RiDeleteBinLine}
                    size="small"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => setConfirming(s.name)}
                  />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
