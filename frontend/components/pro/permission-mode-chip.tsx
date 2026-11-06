// Public stand-in for a component the private edition draws with a licensed UI kit.
// Same exports and props, written from scratch for the open-source build.
"use client";

import {
  autoApplyEditsHint,
  type PermissionMode,
  type PermissionModeControlProps,
  permissionModeOffered,
} from "@/components/chat/permission-mode";
import { AddMenuDivider } from "@/components/chat/composer-add-menu";
import {
  type ComposerPermission,
  COMPOSER_PERMISSIONS,
  PermissionMenu,
  type PermissionMenuOption,
  PermissionMenuRows,
} from "@/components/pro/composer-panel/composer-panel";
import { cx } from "@/utils/cx";

/** The panel face each stored mode wears; the operator-only "auto" reads as Auto. */
const FACE_FOR_MODE: Record<PermissionMode, ComposerPermission> = {
  "read-only": "plan",
  "approval-required": "manual",
  "auto-accept-edits": "auto",
  auto: "auto",
  "full-access": "bypass",
};

/** The mode a picked face sends; Auto applies edits without asking. */
const MODE_FOR_FACE: Record<ComposerPermission, PermissionMode> = {
  plan: "read-only",
  manual: "approval-required",
  auto: "auto-accept-edits",
  bypass: "full-access",
};

const BYPASS_ONLY =
  "This agent cannot stop to ask you first, so it always works without asking.";

/** The line under the rows when the engine cannot honour anything below Bypass all. */
function offeredHint(engine: string | undefined): string | undefined {
  return permissionModeOffered(engine, "approval-required") ? undefined : BYPASS_ONLY;
}

export function permissionModeLabel(mode: PermissionMode): string {
  return COMPOSER_PERMISSIONS[FACE_FOR_MODE[mode]].label;
}

export function permissionModeOptions(engine: string | undefined): PermissionMenuOption[] {
  const titles: Record<ComposerPermission, string> = {
    auto: autoApplyEditsHint(engine),
    manual: "Asks before running a command or changing a file.",
    plan: "Reads and answers; never runs commands or changes files.",
    bypass: "Runs commands and changes files without asking.",
  };
  return Object.values(COMPOSER_PERMISSIONS)
    .filter((row) => permissionModeOffered(engine, MODE_FOR_FACE[row.id]))
    .map((row) => ({
      ...row,
      // Codex's workspace-write policy also runs workspace-bound commands unasked.
      ...(row.id === "auto" && engine === "codex" ? { description: "Edits, repo commands run" } : {}),
      title: titles[row.id],
    }));
}

export function PermissionModePanel({
  mode,
  onChange,
  engine,
}: Omit<PermissionModeControlProps, "disabled">) {
  const hint = offeredHint(engine);
  return (
    <div className="flex flex-col gap-0.5">
      <PermissionMenuRows
        options={permissionModeOptions(engine)}
        value={FACE_FOR_MODE[mode]}
        onSelect={(face) => onChange(MODE_FOR_FACE[face])}
      />
      {hint && (
        <>
          <AddMenuDivider />
          <p className="truncate px-2.5 py-1 text-caption-1-regular text-text-tertiary" title={hint}>
            {hint}
          </p>
        </>
      )}
    </div>
  );
}

export function PermissionModeChip({
  mode,
  onChange,
  engine,
  disabled = false,
  className,
}: PermissionModeControlProps & { className?: string }) {
  return (
    <PermissionMenu
      options={permissionModeOptions(engine)}
      value={FACE_FOR_MODE[mode]}
      onChange={(face) => onChange(MODE_FOR_FACE[face])}
      disabled={disabled}
      hint={offeredHint(engine)}
      className={className}
    />
  );
}

export function PermissionModeTag({ mode }: { mode: PermissionMode | undefined }) {
  if (!mode) return null;
  const face = COMPOSER_PERMISSIONS[FACE_FOR_MODE[mode]];
  const Icon = face.icon;
  return (
    <div className="flex justify-end">
      <span
        data-testid="permission-mode-tag"
        title={`Permission: ${face.label}`}
        className="inline-flex items-center gap-1 text-caption-1-regular text-text-tertiary"
      >
        <Icon aria-hidden className={cx("size-3.5 shrink-0", face.flip && "-scale-x-100")} />
        {face.label}
      </span>
    </div>
  );
}
