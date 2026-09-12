"use client";

import { useSession } from "@/lib/auth";
import { cx } from "@/utils/cx";
import { ThemeToggle } from "./theme-toggle";
import { SettingsCard, SettingsRow } from "./settings-rows";

/**
 * General card - profile and workspace details read from the live better-auth
 * session. Nothing here is editable yet, so the values render as text ("Not
 * set" when the session carries none) rather than as inputs that ignore
 * typing. Client component because ThemeToggle can't cross the server boundary.
 */

export const AVATAR_GRADIENT = "bg-gradient-to-br from-purple-400 to-blue-500 text-white";

/** A read-only value; `null` while the session is still loading. */
function Value({ value }: { value: string | null }) {
  if (value === null) return null;
  return (
    <p className={cx("text-body-2-regular", value ? "text-text-primary" : "text-text-secondary")}>
      {value || "Not set"}
    </p>
  );
}

export function GeneralCard() {
  const { session, loading } = useSession();
  const name = loading ? null : (session?.user.name?.trim() ?? "");
  const email = loading ? null : (session?.user.email ?? "");

  return (
    <SettingsCard>
      <SettingsRow label="Name">
        <Value value={name} />
      </SettingsRow>
      <SettingsRow label="Email">
        <Value value={email} />
      </SettingsRow>
      <SettingsRow label="Workspace name">
        <Value value="useAgent" />
      </SettingsRow>
      <SettingsRow label="Theme" description="Choose your interface theme.">
        <ThemeToggle />
      </SettingsRow>
    </SettingsCard>
  );
}
