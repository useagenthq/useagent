"use client";

import {
  type RemixiconComponentType,
  RiGithubFill,
  RiMailFill,
  RiSearchLine,
  RiSlackFill,
} from "@remixicon/react";
import { useState } from "react";
import { IntegrationConnections } from "@/app/settings/integration-connections";
import { Input } from "@/components/base/input/input";
import { cx } from "@/utils/cx";

/* -------------------------------------------------------------------------- */
/*  Promo banner — a fixed-appearance gradient art element (same in both       */
/*  themes), so its pills stay white and their text uses fixed palette colors. */
/* -------------------------------------------------------------------------- */

interface BannerPill {
  icon: RemixiconComponentType;
  label: string;
  labelClass: string;
  task: string;
  /** Staggered left offset, matching the reference. */
  indent: string;
}

const bannerPills: BannerPill[] = [
  {
    icon: RiSlackFill,
    label: "Slack",
    labelClass: "text-[#611f69]",
    task: "Summarize key updates from recent conversations",
    indent: "ml-0",
  },
  {
    icon: RiGithubFill,
    label: "GitHub",
    labelClass: "text-[#24292f]",
    task: "Review open issues and pull request activity",
    indent: "ml-3.5",
  },
  {
    icon: RiMailFill,
    label: "Gmail",
    labelClass: "text-[#ea4335]",
    task: "Draft replies for every email I'm behind on",
    indent: "ml-7",
  },
];

function PromoBanner() {
  return (
    <div className="relative flex min-h-[200px] flex-col justify-center overflow-hidden rounded-2xl p-6">
      {/* base wash + soft mesh blobs → pink → purple → blue */}
      <div className="absolute inset-0 bg-linear-120 from-pink-200 via-purple-300 to-sky-300" />
      <div className="absolute -left-12 -top-10 size-72 rounded-full bg-purple-300/70 blur-3xl" />
      <div className="absolute left-1/3 -bottom-16 size-72 rounded-full bg-pink-300/60 blur-3xl" />
      <div className="absolute -right-8 top-1/2 size-80 -translate-y-1/2 rounded-full bg-sky-300/70 blur-3xl" />

      <div className="relative flex flex-col gap-3 pl-4 sm:pl-8">
        {bannerPills.map(({ icon: Icon, label, labelClass, task, indent }) => (
          <div
            key={label}
            className={cx(
              "inline-flex w-fit max-w-full items-center gap-3 rounded-full bg-white py-2 pl-2 pr-5 shadow-sm",
              indent,
            )}
          >
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-neutral-50 px-2.5 py-1 ring-1 ring-black/[0.04]">
              <Icon className={cx("size-4 shrink-0", labelClass)} aria-hidden />
              <span className={cx("text-body-2-medium", labelClass)}>{label}</span>
            </span>
            <span className="truncate text-body-2-regular text-neutral-800">{task}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page content                                                             */
/* -------------------------------------------------------------------------- */

export function AppsMarketplace() {
  const [query, setQuery] = useState("");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10 sm:px-8">
      <div className="flex flex-col gap-5">
        <h1 className="text-center text-display-sm text-text-primary">
          Connect the tools your team already uses
        </h1>
        <Input
          aria-label="Search marketplace"
          leadingIcon={RiSearchLine}
          placeholder="Search marketplace..."
          value={query}
          onChange={setQuery}
        />
      </div>

      <PromoBanner />

      <section className="flex flex-col gap-5">
        <h2 className="text-body-2-medium text-text-primary">Featured</h2>
        <IntegrationConnections query={query} />
      </section>
    </div>
  );
}
