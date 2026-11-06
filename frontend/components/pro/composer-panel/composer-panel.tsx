// Public stand-in for a component the private edition draws with a licensed UI kit.
// Same exports and props, written from scratch for the open-source build.
"use client";

import {
  type RemixiconComponentType,
  RiAddLine,
  RiAttachment2,
  RiCheckLine,
  RiErrorWarningLine,
  RiGitMergeLine,
  RiRouteLine,
  RiShieldCheckLine,
  RiSpeedUpFill,
} from "@remixicon/react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { type KeyboardEvent, useState } from "react";
import { CloseButton } from "@/components/base/buttons/close-button";
import { Dropdown, DropdownPopover, DropdownTrigger } from "@/components/base/dropdown/dropdown";
import { ADD_MENU_ROW, AddMenuDivider, RowText } from "@/components/chat/composer-add-menu";
import { EASE_OUT } from "@/lib/motion";
import { cx } from "@/utils/cx";

/* ------------------------------------------------------------- permissions */

export type ComposerPermission = "auto" | "manual" | "plan" | "bypass";

export interface PermissionMenuOption<Id extends string = ComposerPermission> {
  id: Id;
  label: string;
  description: string;
  icon: RemixiconComponentType;
  /** Figma draws the branch and route glyphs mirrored on the vertical axis. */
  flip?: boolean;
  /** useAgent: the row's title attribute, for a longer sentence than the one-line description. */
  title?: string;
}

export const COMPOSER_PERMISSIONS: Record<ComposerPermission, PermissionMenuOption> = {
  auto: { id: "auto", label: "Auto", description: "Edits run, commands ask", icon: RiSpeedUpFill },
  manual: { id: "manual", label: "Manual", description: "Asks to run or edit", icon: RiShieldCheckLine },
  plan: { id: "plan", label: "Plan mode", description: "Reads, edits nothing", icon: RiRouteLine, flip: true },
  bypass: { id: "bypass", label: "Bypass all", description: "Runs, edits unasked", icon: RiGitMergeLine, flip: true },
};

/** Arrow keys move focus between the rows; Enter or Space picks one. */
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const at = rows.findIndex((row) => row === document.activeElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  rows[(Math.max(at, 0) + step + rows.length) % rows.length]?.focus();
}

export function PermissionMenuRows<Id extends string>({
  options,
  value,
  onSelect,
}: {
  options: readonly PermissionMenuOption<Id>[];
  value: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Permission mode" className="flex flex-col gap-0.5" onKeyDown={moveRowFocus}>
      {options.map((option) => {
        const selected = option.id === value;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            onClick={() => onSelect(option.id)}
            className={cx(ADD_MENU_ROW, "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring", selected && "bg-background-primary-hover")}
          >
            <Icon
              aria-hidden
              className={cx("size-4 shrink-0 text-foreground-icon-secondary", option.flip && "-scale-x-100")}
            />
            <RowText inline title={option.label} description={option.description} />
            {selected && <RiCheckLine aria-hidden className="size-4 shrink-0 text-foreground-icon-primary" />}
          </button>
        );
      })}
    </div>
  );
}

export interface PermissionMenuProps {
  /** The rows offered; the trigger draws `value`'s face even when it is not among them. */
  options: readonly PermissionMenuOption[];
  value: ComposerPermission;
  onChange: (permission: ComposerPermission) => void;
  /** useAgent: the next submission cannot carry a mode; show it, offer no change. */
  disabled?: boolean;
  /** useAgent: a line under the rows, for what the offered set means on this engine. */
  hint?: string;
  className?: string;
}

const PERMISSION_POPOVER = [
  "w-72 max-w-[calc(100vw-2rem)]",
  "rounded-[14px] border border-border-button-default bg-background-primary-default p-1.5 shadow-card",
].join(" ");

export function PermissionMenu({
  options,
  value,
  onChange,
  disabled = false,
  hint,
  className,
}: PermissionMenuProps) {
  const [open, setOpen] = useState(false);
  const face = COMPOSER_PERMISSIONS[value];
  const Icon = face.icon;
  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <DropdownTrigger
        aria-label={`Permission: ${face.label}`}
        isDisabled={disabled}
        className={cx(
          "button-press-motion flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 hover:bg-background-primary-hover",
          disabled && "cursor-default hover:bg-transparent",
          className,
        )}
      >
        <Icon
          aria-hidden
          className={cx("size-4 shrink-0 text-foreground-icon-secondary", face.flip && "-scale-x-100")}
        />
        <span className="text-body-2-medium whitespace-nowrap text-text-secondary">{face.label}</span>
      </DropdownTrigger>
      <DropdownPopover aria-label="Permissions" placement="top start" className={PERMISSION_POPOVER}>
        <p className="px-2.5 pb-0.5 pt-0.5 text-mono-label text-text-tertiary">Permissions</p>
        <PermissionMenuRows
          options={options}
          value={value}
          onSelect={(id) => {
            setOpen(false);
            onChange(id);
          }}
        />
        {hint && (
          <>
            <AddMenuDivider />
            <p className="truncate px-2.5 py-1 text-caption-1-regular text-text-tertiary" title={hint}>
              {hint}
            </p>
          </>
        )}
      </DropdownPopover>
    </Dropdown>
  );
}

/* ------------------------------------------------------------- attachments */

export type ComposerAttachmentKind =
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "code"
  | "video"
  // useAgent: a file of no known kind, drawn with the paperclip.
  | "file";

export interface ComposerAttachment {
  id: string;
  name: string;
  kind: ComposerAttachmentKind;
  /** Thumbnail for image tiles. */
  src?: string;
  /**
   * 0 to 100 draws the upload ring around the tile (the closed ring at 100);
   * leave it out once the file has landed, which also reveals the dismiss.
   */
  progress?: number;
  /** useAgent: the upload did not land; the warning mark stands where the ring was. */
  failed?: boolean;
  /** useAgent: why it did not land, worded to follow the name ("is empty"). */
  failedReason?: string;
}

export interface ComposerAttachmentTileProps {
  attachment: ComposerAttachment;
  /** Renders the dismiss in the top-right corner once the file has landed. */
  onRemove?: () => void;
  className?: string;
}

const KIND_ICONS: Partial<Record<ComposerAttachmentKind, string>> = {
  document: "/plugin-icons/plugin-documents.svg",
  spreadsheet: "/plugin-icons/plugin-spreadsheets.svg",
  presentation: "/plugin-icons/plugin-presentations.svg",
  code: "/plugin-icons/plugin-codeblocks.svg",
  video: "/plugin-icons/plugin-videos.svg",
};

function UploadRing({ progress }: { progress: number }) {
  const percent = Math.round(Math.min(100, Math.max(0, progress)));
  return (
    <div
      role="progressbar"
      aria-label={`Uploading, ${percent}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="absolute inset-0 flex items-center justify-center bg-background-primary-default/75"
    >
      <svg viewBox="0 0 36 36" className="size-10 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="stroke-chart-track" />
        <circle
          cx="18"
          cy="18"
          r="15"
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${percent} 200`}
          className="stroke-accent-500"
        />
      </svg>
      <span className="absolute text-caption-2-medium text-text-primary tabular-nums">{`${percent}%`}</span>
    </div>
  );
}

export function ComposerAttachmentTile({
  attachment,
  onRemove,
  className,
}: ComposerAttachmentTileProps) {
  const { name, kind, src, progress, failed = false, failedReason } = attachment;
  const uploading = !failed && progress !== undefined;
  const icon = KIND_ICONS[kind];
  return (
    <div
      data-attachment-kind={kind}
      data-status={failed ? "error" : uploading ? "uploading" : "ready"}
      title={failed && failedReason ? `${name} ${failedReason}` : name}
      className={cx("relative size-16 shrink-0", className)}
    >
      <div className="relative flex size-full flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border border-composer-panel-tile-border bg-background-secondary-default">
        {kind === "image" && src ? (
          <img src={src} alt={name} className="size-full object-cover" />
        ) : (
          <>
            {icon ? (
              <img src={icon} alt="" width={20} height={20} className="size-5 shrink-0" aria-hidden />
            ) : (
              <RiAttachment2 aria-hidden className="size-5 shrink-0 text-foreground-icon-secondary" />
            )}
            <span className="max-w-full truncate px-1.5 text-caption-2-regular text-text-secondary">{name}</span>
          </>
        )}
        {uploading && <UploadRing progress={progress} />}
        {failed && (
          <span
            role="img"
            aria-label={failedReason ? `Upload failed: ${name} ${failedReason}` : "Upload failed"}
            className="absolute inset-0 flex items-center justify-center bg-background-primary-default/75"
          >
            <RiErrorWarningLine aria-hidden className="size-5 text-text-error-primary" />
          </span>
        )}
      </div>
      {onRemove && (
        <CloseButton
          size="2xs"
          aria-label={`Remove ${name}`}
          disabled={uploading}
          onClick={onRemove}
          className={cx(
            "absolute -top-1.5 -right-1.5 border border-composer-panel-tile-border transition-[opacity,filter] duration-200",
            uploading ? "pointer-events-none opacity-0 blur-[2px]" : "opacity-100 blur-0",
          )}
        />
      )}
    </div>
  );
}

export const VISIBLE_ATTACHMENTS = 8;

export interface ComposerAttachmentStripProps {
  attachments: ComposerAttachment[];
  onRemove?: (id: string) => void;
  className?: string;
}

export function ComposerAttachmentStrip({
  attachments,
  onRemove,
  className,
}: ComposerAttachmentStripProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? attachments : attachments.slice(0, VISIBLE_ATTACHMENTS);
  const folded = attachments.length - shown.length;
  return (
    <MotionConfig reducedMotion="user">
      {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics from an unstyled list unless the role is explicit. */}
      <ul role="list" aria-label="Attached files" className={cx("flex flex-wrap items-center gap-2", className)}>
        <AnimatePresence initial={false}>
          {shown.map((attachment) => (
            <motion.li
              key={attachment.id}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15, ease: EASE_OUT }}
            >
              <ComposerAttachmentTile
                attachment={attachment}
                onRemove={onRemove ? () => onRemove(attachment.id) : undefined}
              />
            </motion.li>
          ))}
        </AnimatePresence>
        {folded > 0 && (
          <li>
            <button
              type="button"
              aria-label={`Show ${folded} more attachments`}
              onClick={() => setExpanded(true)}
              className="flex size-16 cursor-pointer items-center justify-center rounded-xl border border-composer-panel-tile-border text-body-2-medium text-text-secondary transition-colors hover:bg-background-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              {`+${folded}`}
            </button>
          </li>
        )}
      </ul>
    </MotionConfig>
  );
}

export function ComposerAddButton({
  open,
  onToggle,
  className,
  "aria-label": label,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onToggle}
      className={cx(
        "button-press-motion flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-composer-panel-add-background text-text-primary hover:bg-composer-panel-add-hover-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        className,
      )}
    >
      <RiAddLine aria-hidden className={cx("size-5 transition-transform duration-200 ease-out", open && "rotate-45")} />
    </button>
  );
}
