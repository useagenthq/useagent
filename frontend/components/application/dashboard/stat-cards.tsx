import type { ComponentType } from "react";
import {
  RiBox3Line,
  RiChatSmile2Line,
  RiGroupLine,
  RiShoppingBasketLine,
} from "@remixicon/react";
import { Chip } from "@/components/base/badges/chip";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → dashboard 1 → Frame 20 (node 3731:3160).
 *
 * Four KPI cards: semantic icon tile, label, value, delta chip.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

type Stat = {
  icon: IconComponent;
  label: string;
  value: string;
  delta: string;
  deltaColor: "lime" | "rose" | "neutral";
};

const stats: Stat[] = [
  { icon: RiGroupLine, label: "Customers", value: "14,592", delta: "+5.3%", deltaColor: "lime" },
  { icon: RiBox3Line, label: "Unit sold", value: "385", delta: "-2.1%", deltaColor: "rose" },
  { icon: RiShoppingBasketLine, label: "Orders", value: "1,394", delta: "0.00%", deltaColor: "neutral" },
  { icon: RiChatSmile2Line, label: "Support tickets", value: "708", delta: "+12.8%", deltaColor: "lime" },
];

export function StatCards({
  count = stats.length,
  className,
}: {
  /** How many KPI cards to render (from the start of the list). */
  count?: number;
  className?: string;
} = {}) {
  return (
    <div className={cx("grid w-full grid-cols-2 gap-4 lg:grid-cols-4", className)}>
      {stats.slice(0, count).map((stat) => (
        <section
          key={stat.label}
          className="flex h-[132px] min-w-0 flex-col items-start justify-between rounded-2xl bg-background-secondary-default p-4"
        >
          <span className="flex items-center rounded-md bg-stat-card-icon-background p-1.5">
            <stat.icon className="size-5 shrink-0 text-foreground-icon-primary" aria-hidden />
          </span>
          <div className="flex w-full flex-col gap-0.5">
            <p className="w-full text-body-medium text-text-secondary">{stat.label}</p>
            <div className="flex w-full flex-wrap items-center gap-2">
              <p className="text-title-1-medium whitespace-nowrap text-text-primary">
                {stat.value}
              </p>
              <Chip variant="bold" color={stat.deltaColor}>
                {stat.delta}
              </Chip>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
