"use client";

import { RiMailLine, RiPencilLine } from "@remixicon/react";
import * as Avatar from "@/components/ui/avatar";
import * as Button from "@/components/ui/button";
import * as Input from "@/components/ui/input";
import { ThemeToggle } from "./theme-toggle";
import { SettingsCard, SettingsRow } from "./settings-rows";

/**
 * General card — identity header + editable profile/workspace inputs, reusing
 * the local SettingsCard/SettingsRow chrome. Client component because the
 * ThemeToggle and the icon-prop Input can't cross the server boundary.
 */

export const AVATAR_GRADIENT = "bg-gradient-to-br from-purple-400 to-blue-500 text-static-white";

const INPUT_WIDTH = "w-[220px] shrink-0";

export function GeneralCard() {
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <Avatar.Root size="48" className={AVATAR_GRADIENT}>
          A
        </Avatar.Root>
        <div className="min-w-0 flex-1">
          <p className="truncate text-label-sm text-text-strong-950">Dev User</p>
          <p className="truncate text-paragraph-xs text-text-sub-600">you@example.com</p>
        </div>
        <Button.Root className="rounded-full" variant="neutral" mode="stroke" size="xsmall">
          <Button.Icon as={RiPencilLine} />
          Change
        </Button.Root>
      </div>

      <SettingsCard>
        <SettingsRow label="Name">
          <Input.Root size="small" className={INPUT_WIDTH}>
            <Input.Wrapper>
              <Input.Input aria-label="Name" defaultValue="Dev User" />
            </Input.Wrapper>
          </Input.Root>
        </SettingsRow>
        <SettingsRow label="Email">
          <Input.Root size="small" className={INPUT_WIDTH}>
            <Input.Wrapper>
              <Input.Icon as={RiMailLine} />
              <Input.Input aria-label="Email" type="email" defaultValue="you@example.com" />
            </Input.Wrapper>
          </Input.Root>
        </SettingsRow>
        <SettingsRow label="Workspace name">
          <Input.Root size="small" className={INPUT_WIDTH}>
            <Input.Wrapper>
              <Input.Input aria-label="Workspace name" defaultValue="Skynet" />
            </Input.Wrapper>
          </Input.Root>
        </SettingsRow>
        <SettingsRow label="Theme" description="Choose your interface theme.">
          <ThemeToggle />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}
