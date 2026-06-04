"use client";

import { RiAppsLine, RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import { IntegrationConnections } from "@/app/settings/integration-connections";
import { Input } from "@/components/base/input/input";

export function AppsMarketplace() {
  const [query, setQuery] = useState("");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10 sm:px-8">
      <div className="flex flex-col gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <RiAppsLine aria-hidden className="size-5 text-foreground-icon-primary" />
            <h1 className="text-title-2-medium text-text-primary">Apps</h1>
          </div>
          <p className="mt-1.5 text-body-2-regular text-text-secondary">
            Connect the tools your team already uses.
          </p>
        </div>
        <Input
          aria-label="Search marketplace"
          leadingIcon={RiSearchLine}
          placeholder="Search marketplace..."
          value={query}
          onChange={setQuery}
        />
      </div>

      <section className="flex flex-col gap-5">
        <h2 className="text-body-2-medium text-text-primary">Featured</h2>
        <IntegrationConnections query={query} />
      </section>
    </div>
  );
}
