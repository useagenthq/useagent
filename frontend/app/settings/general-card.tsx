"use client";

import { RiMailLine } from "@remixicon/react";
import { InputBase } from "@/components/base/input/input";
import { useSession } from "@/lib/auth";
import { ThemeToggle } from "./theme-toggle";
import { SettingsCard, SettingsRow } from "./settings-rows";

/**
 * General card — editable profile/workspace inputs bound to the live
 * better-auth session (no duplicate identity header: the inputs ARE the
 * identity). Client component because ThemeToggle and the icon-prop Input
 * can't cross the server boundary.
 */

export const AVATAR_GRADIENT = "bg-gradient-to-br from-purple-400 to-blue-500 text-white";

const INPUT_WIDTH = "w-[220px] shrink-0";

export function GeneralCard() {
  const { session } = useSession();
  const name = session?.user.name?.trim() ?? "";
  const email = session?.user.email ?? "";

  return (
    <SettingsCard>
      <SettingsRow label="Name">
        <InputBase
          key={name || "name-pending"}
          size="small"
          aria-label="Name"
          defaultValue={name}
          placeholder="Add your name"
          fieldClassName={INPUT_WIDTH}
        />
      </SettingsRow>
      <SettingsRow label="Email">
        <InputBase
          key={email || "email-pending"}
          size="small"
          aria-label="Email"
          type="email"
          defaultValue={email}
          placeholder="you@company.com"
          leadingIcon={RiMailLine}
          fieldClassName={INPUT_WIDTH}
        />
      </SettingsRow>
      <SettingsRow label="Workspace name">
        <InputBase
          size="small"
          aria-label="Workspace name"
          defaultValue="useAgent"
          fieldClassName={INPUT_WIDTH}
        />
      </SettingsRow>
      <SettingsRow label="Theme" description="Choose your interface theme.">
        <ThemeToggle />
      </SettingsRow>
    </SettingsCard>
  );
}
