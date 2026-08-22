import { RiArrowLeftLine, RiArrowRightLine } from "@remixicon/react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { ChevronDownSmall } from "@/components/foundations/icons/chevrons";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → dashboard 1 → Frame 125 (node 3731:3042).
 *
 * "Recent hires" card: metric header, 2×2 grid of people cards, pagination.
 */

const hires = [
  { name: "Livia Saris", joined: "Joined today", role: "Backend Engineer", src: "/avatars/livia-saris.webp" },
  { name: "Jaydon Aminoff", joined: "2 days ago", role: "UI Designer", src: "/avatars/jaydon-aminoff.webp" },
  { name: "Maria Lubin", joined: "5 days ago", role: "User Researcher", src: "/avatars/maria-lubin.webp" },
  { name: "Ann Press", joined: "A week ago", role: "DevOps Engineer", src: "/avatars/ann-press.webp" },
];

export function RecentHiresCard({ className }: { className?: string }) {
  return (
    <section className={cx("relative flex h-[329px] min-w-0 flex-1 flex-col rounded-2xl bg-background-secondary-default p-2", className)}>
      {/* Header */}
      <div className="flex items-start justify-between px-2 pt-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-body-medium text-text-secondary">Recent hires</p>
          <p className="text-title-1-medium whitespace-nowrap text-text-primary">56</p>
        </div>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 rounded-2lg px-0.5"
        >
          <span className="text-body-medium whitespace-nowrap text-text-primary">
            Board team
          </span>
          <ChevronDownSmall className="size-4 shrink-0 text-text-secondary" />
        </button>
      </div>

      {/* People grid */}
      <div className="mt-[11px] grid flex-1 grid-cols-2 grid-rows-2 gap-2">
        {hires.map((hire) => (
          <div
            key={hire.name}
            className="flex min-w-0 flex-col items-start justify-between rounded-2lg bg-background-inner-default p-2.5 shadow-card"
          >
            <div className="flex w-full min-w-0 items-center gap-2">
              <Avatar size="lg" src={hire.src} alt={hire.name} />
              <div className="flex min-w-0 flex-1 flex-col items-start justify-center">
                <p className="w-full truncate text-body-medium text-text-primary">
                  {hire.name}
                </p>
                <p className="w-full truncate text-body-2-medium text-text-secondary">
                  {hire.joined}
                </p>
              </div>
            </div>
            <Chip
              variant="caption"
              color="soft"
              className="w-full bg-background-recent-hire-role"
            >
              {hire.role}
            </Chip>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <div className="mt-2 flex w-full items-center gap-2">
        <Button variant="secondary" size="small" leadingIcon={RiArrowLeftLine} className="flex-1">
          Previous
        </Button>
        <Button variant="secondary" size="small" trailingIcon={RiArrowRightLine} className="flex-1">
          Next
        </Button>
      </div>
    </section>
  );
}
