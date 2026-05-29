import { RiLoader4Line } from "@remixicon/react";
import type { ReactNode } from "react";
import { Chip } from "@/components/base/badges/chip";
import { cx } from "@/utils/cx";
import type { ConnectionBadgeStatus } from "./provider-connections-data";

/**
 * Shared chrome for the provider-connection status pills: a quiet BoardUI Chip
 * with a leading dot. The dot color defaults to the chip text (bg-current);
 * `dotClassName` lets the revoked state keep its small red dot without the
 * whole chip shouting.
 */

const STATUS_CHIP_COLOR: Record<ConnectionBadgeStatus, "lime" | "yellow" | "soft"> = {
  completed: "lime",
  pending: "yellow",
  disabled: "soft",
};

export function ConnectionStatusChip({
  status,
  dotClassName,
  children,
}: {
  status: ConnectionBadgeStatus;
  dotClassName?: string;
  children: ReactNode;
}) {
  return (
    <Chip variant="caption" color={STATUS_CHIP_COLOR[status]} className="gap-1">
      <span aria-hidden className={cx("size-1.5 rounded-full bg-current", dotClassName)} />
      {children}
    </Chip>
  );
}

/** Spinning loader glyph sized by the Button's icon slot (`leadingIcon`). */
export function SpinnerIcon(props: {
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  return <RiLoader4Line {...props} className={cx(props.className, "animate-spin")} />;
}
