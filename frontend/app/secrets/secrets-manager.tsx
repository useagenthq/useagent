"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RiDeleteBinLine,
  RiKey2Line,
  RiLoader4Line,
} from "@remixicon/react";
import * as Button from "@/components/ui/button";
import * as Input from "@/components/ui/input";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { cnExt } from "@/utils/cn";
import { deleteSecret, fetchSecrets, putSecret } from "./secrets-api";
import { isValidSecretName, SECRET_KINDS, type SecretKind, type SecretMeta } from "./secrets-data";

const MASK = "••••••••";

/** Relative "updated Xm ago" label. Client-only (reads the clock), so callers
 *  render it behind a mounted gate to avoid a server/client hydration mismatch. */
function relTime(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function byName(a: SecretMeta, b: SecretMeta): number {
  return a.name.localeCompare(b.name);
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
            <Input.Root hasError={nameInvalid}>
              <Input.Wrapper>
                <Input.Icon as={RiKey2Line} />
                <Input.Input
                  aria-label="Secret name"
                  placeholder="SECRET_NAME"
                  spellCheck={false}
                  autoCapitalize="characters"
                  className="font-mono"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Input.Wrapper>
            </Input.Root>
          </div>
          <div className="min-w-0 flex-1">
            <Input.Root>
              <Input.Wrapper>
                <Input.Input
                  aria-label="Secret value"
                  placeholder="Value (write-only)"
                  type="password"
                  autoComplete="off"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </Input.Wrapper>
            </Input.Root>
          </div>
          {/* Kind toggle: env var vs materialized file. */}
          <div
            role="radiogroup"
            aria-label="Secret kind"
            className="inline-flex shrink-0 rounded-full border border-stroke-soft-200 p-0.5"
          >
            {SECRET_KINDS.map((k) => (
              <label
                key={k}
                className={cnExt(
                  "cursor-pointer rounded-full px-3 py-1 text-label-xs capitalize transition-colors focus-within:ring-2 focus-within:ring-stroke-strong-950",
                  kind === k
                    ? "bg-bg-strong-950 text-text-white-0"
                    : "text-text-sub-600 hover:text-text-strong-950",
                )}
              >
                <input
                  type="radio"
                  name="secret-kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  className="sr-only"
                />
                {k}
              </label>
            ))}
          </div>
          <Button.Root
            type="submit"
            variant="neutral"
            mode="stroke"
            size="small"
            className="rounded-full"
            disabled={!canSave}
          >
            {saving ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : null}
            {exists ? "Update" : "Add secret"}
          </Button.Root>
        </div>
        {nameInvalid ? (
          <p className="text-paragraph-xs text-error-base">
            Use an env-var name: an uppercase letter, then uppercase letters, digits, or underscores (e.g. GCP_SA_KEY).
          </p>
        ) : kind === "file" ? (
          <p className="text-paragraph-xs text-text-soft-400">
            Written to a 0600 file in every sandbox this workspace boots; the env var holds its path.
          </p>
        ) : (
          <p className="text-paragraph-xs text-text-soft-400">
            Injected as an environment variable into every sandbox this workspace boots.
          </p>
        )}
        {saveError && <p className="text-paragraph-xs text-error-base">{saveError}</p>}
      </form>

      {/* List / empty / error */}
      {error && secrets.length === 0 ? (
        <BackendUnreachable onRetry={refetch} />
      ) : loading && secrets.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-paragraph-sm text-text-sub-600">
          <RiLoader4Line aria-hidden className="size-4 animate-spin" />
          Loading secrets...
        </div>
      ) : secrets.length === 0 ? (
        <p className="py-6 text-paragraph-sm text-text-sub-600">
          No secrets yet. Add one above to inject it into every sandbox this workspace boots.
        </p>
      ) : (
        <div className="flex flex-col">
          {secrets.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-3 border-b border-stroke-soft-200 py-2.5 last:border-b-0"
            >
              <RiKey2Line aria-hidden className="size-4 shrink-0 text-text-soft-400" />
              <span className="min-w-0 flex-1 truncate font-mono text-label-sm text-text-strong-950">
                {s.name}
              </span>
              {s.kind === "file" && (
                <span className="shrink-0 rounded-full border border-stroke-soft-200 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-text-soft-400">
                  file
                </span>
              )}
              <span
                className="hidden select-none font-mono text-paragraph-xs text-text-sub-600 sm:inline"
                aria-hidden
              >
                {MASK}
              </span>
              {mounted && (
                <span className="hidden text-paragraph-xs text-text-soft-400 sm:inline">
                  Updated {relTime(s.updatedAt)}
                </span>
              )}
              {confirming === s.name ? (
                <div className="flex items-center gap-1">
                  <Button.Root
                    type="button"
                    variant="neutral"
                    mode="ghost"
                    size="xsmall"
                    className="rounded-full"
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Button.Root>
                  <Button.Root
                    type="button"
                    variant="error"
                    mode="stroke"
                    size="xsmall"
                    className="rounded-full"
                    onClick={() => void remove(s.name)}
                  >
                    Delete
                  </Button.Root>
                </div>
              ) : (
                <Button.Root
                  type="button"
                  variant="neutral"
                  mode="ghost"
                  size="xsmall"
                  aria-label={`Delete ${s.name}`}
                  className={cnExt("rounded-full")}
                  onClick={() => setConfirming(s.name)}
                >
                  <Button.Icon as={RiDeleteBinLine} />
                </Button.Root>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
