"use client";

import { RiMailLine, RiPencilLine } from "@remixicon/react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { cx } from "@/utils/cx";
import { ThemeToggle } from "./theme-toggle";
import { SettingsCard, SettingsRow } from "./settings-rows";

/**
 * General card — identity header + editable profile/workspace inputs, reusing
 * the local SettingsCard/SettingsRow chrome. Client component because the
 * ThemeToggle and the icon-prop Input can't cross the server boundary.
 */

export const AVATAR_GRADIENT = "bg-gradient-to-br from-purple-400 to-blue-500 text-white";

const INPUT_WIDTH = "w-[220px] shrink-0";

export function GeneralCard() {
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <Avatar size="lg" className={cx("size-12 text-[18px]", AVATAR_GRADIENT)} initials="U" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-2-medium text-text-primary">Your Name</p>
          <p className="truncate text-caption-1-regular text-text-secondary">you@example.com</p>
        </div>
        <Button className="rounded-full" variant="secondary" size="xs" leadingIcon={RiPencilLine}>
          Change
        </Button>
      </div>

      <SettingsCard>
        <SettingsRow label="Name">
          <InputBase size="small" aria-label="Name" defaultValue="Your Name" fieldClassName={INPUT_WIDTH} />
        </SettingsRow>
        <SettingsRow label="Email">
          <InputBase
            size="small"
            aria-label="Email"
            type="email"
            defaultValue="you@example.com"
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
    </>
  );
}
