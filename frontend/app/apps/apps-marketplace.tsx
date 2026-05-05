"use client";

import { useMemo, useState } from "react";
import {
  RiAddLine,
  RiCheckLine,
  RiGithubFill,
  RiMailFill,
  RiSearchLine,
  RiSlackFill,
  type RemixiconComponentType,
} from "@remixicon/react";

import * as Input from "@/components/ui/input";
import { cnExt } from "@/utils/cn";
import { integrations, type Integration } from "./integrations";

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
            className={cnExt(
              "inline-flex w-fit max-w-full items-center gap-3 rounded-full bg-white py-2 pl-2 pr-5 shadow-regular-sm",
              indent,
            )}
          >
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-neutral-50 px-2.5 py-1 ring-1 ring-black/[0.04]">
              <Icon className={cnExt("size-4 shrink-0", labelClass)} aria-hidden />
              <span className={cnExt("text-label-sm", labelClass)}>{label}</span>
            </span>
            <span className="truncate text-paragraph-sm text-neutral-800">
              {task}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Featured grid                                                             */
/* -------------------------------------------------------------------------- */

interface IntegrationRowProps {
  integration: Integration;
  connected: boolean;
  onToggle: (name: string) => void;
}

function IntegrationRow({
  integration,
  connected,
  onToggle,
}: IntegrationRowProps) {
  const { name, description, icon: Icon, iconClass } = integration;

  return (
    <li className="flex items-center gap-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs">
        <Icon className={cnExt("size-6", iconClass)} aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-label-sm text-text-strong-950">{name}</p>
        <p className="truncate text-paragraph-sm text-text-sub-600">
          {description}
        </p>
      </div>

      <button
        type="button"
        onClick={() => onToggle(name)}
        aria-label={connected ? `Disconnect ${name}` : `Connect ${name}`}
        className={cnExt(
          "flex size-7 shrink-0 items-center justify-center rounded-lg text-text-sub-600 transition-colors",
          connected
            ? "hover:bg-bg-soft-200"
            : "bg-bg-soft-200 hover:bg-bg-sub-300",
        )}
      >
        {connected ? (
          <RiCheckLine className="size-4" aria-hidden />
        ) : (
          <RiAddLine className="size-4" aria-hidden />
        )}
      </button>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page content                                                             */
/* -------------------------------------------------------------------------- */

export function AppsMarketplace() {
  const [query, setQuery] = useState("");
  const [connected, setConnected] = useState<Set<string>>(
    () => new Set(integrations.filter((i) => i.connected).map((i) => i.name)),
  );

  const toggle = (name: string) =>
    setConnected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return integrations;
    return integrations.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10 sm:px-8">
      <div className="flex flex-col gap-5">
        <h1 className="text-center text-display-sm text-text-strong-950">
          Connect the tools your team already uses
        </h1>
        <Input.Root>
          <Input.Wrapper>
            <Input.Icon as={RiSearchLine} />
            <Input.Input
              aria-label="Search marketplace"
              placeholder="Search marketplace..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Input.Wrapper>
        </Input.Root>
      </div>

      <PromoBanner />

      <section className="flex flex-col gap-5">
        <h2 className="text-label-sm text-text-strong-950">Featured</h2>
        {results.length > 0 ? (
          <ul className="grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
            {results.map((integration) => (
              <IntegrationRow
                key={integration.name}
                integration={integration}
                connected={connected.has(integration.name)}
                onToggle={toggle}
              />
            ))}
          </ul>
        ) : (
          <p className="text-paragraph-sm text-text-sub-600">
            No integrations match “{query}”.
          </p>
        )}
      </section>
    </div>
  );
}
