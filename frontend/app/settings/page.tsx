import type { Metadata } from "next";
import type { ReactNode } from "react";
import { RiCameraLine, RiPencilLine } from "@remixicon/react";
import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { GeneralCard } from "./general-card";
import { ProviderConnectionsCard } from "./provider-connections-card";
import { SecretsCard } from "./secrets-card";
import { SettingsCard, SettingsRow } from "./settings-rows";
import { SettingsRail } from "./settings-rail";
import { TeamCard } from "./team-card";
import { UsageMeters } from "./usage-meters";

export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your workspace, usage, machine snapshots, secrets, and team.",
};

/** Inverted pill (dark on light, light on dark). */
const DARK_PILL =
  "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full bg-bg-strong-950 px-3.5 text-label-sm text-text-white-0 shadow-regular-xs outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-stroke-strong-950";

/* -------------------------------------------------------------------------- */
/*  Section shell                                                              */
/* -------------------------------------------------------------------------- */

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-5 shadow-regular-sm">
        <div className="mb-4 flex flex-col gap-0.5">
          <h2 className="text-title-h6 text-text-strong-950">{title}</h2>
          {description && <p className="text-paragraph-xs text-text-sub-600">{description}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function SettingsPage() {
  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="settings" />}>
      <div className="mx-auto w-full max-w-4xl px-6 py-8 lg:px-10">
        <h1 className="text-display-sm text-text-strong-950">Settings</h1>

        <div className="mt-8 flex gap-8">
          {/* Sticky section rail */}
          <aside className="hidden w-40 shrink-0 lg:block">
            <div className="sticky top-6">
              <SettingsRail />
            </div>
          </aside>

          {/* Sections */}
          <div className="flex min-w-0 flex-1 flex-col gap-8">
            {/* General */}
            <Section id="general" title="General" description="Your profile and workspace details.">
              <GeneralCard />
            </Section>

            {/* Usage */}
            <Section id="usage" title="Usage" description="Your plan and model consumption this cycle.">
              <SettingsCard className="mb-4">
                <SettingsRow label="Plan" description="Free while you get started.">
                  <Badge.Root variant="light" size="medium" color="gray">
                    Starter - Free
                  </Badge.Root>
                </SettingsRow>
              </SettingsCard>

              {/* Real per-model token burn from GET /api/fleet (same live source
                  as the workspace Limits card). No credits meter - there is no
                  billing/credit system yet, so a fabricated "N / 2,000 credits"
                  bar was removed rather than faked. */}
              <UsageMeters />
            </Section>

            {/* Machine */}
            <Section id="machine" title="Machine" description="The saved VM state new sessions boot from.">
              <div className="flex flex-col gap-3 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-4">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-bg-white-0 px-2 py-0.5 font-mono text-[0.6875rem] text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
                    snapshot-2026-07-24
                  </span>
                </div>
                <p className="text-paragraph-xs text-text-sub-600">Node 24 · pnpm · Playwright</p>
                <div className="flex flex-wrap gap-2">
                  <Button.Root className="rounded-full" variant="neutral" mode="stroke" size="xsmall">
                    <Button.Icon as={RiPencilLine} />
                    Edit machine
                  </Button.Root>
                  <button type="button" className={DARK_PILL}>
                    <RiCameraLine className="size-4 shrink-0" aria-hidden />
                    New snapshot
                  </button>
                </div>
              </div>
            </Section>

            {/* Secrets */}
            <Section id="secrets" title="Secrets" description="Persisted for every future session on this workspace.">
              <SecretsCard />
            </Section>

            {/* Provider connections */}
            <Section
              id="providers"
              title="Provider connections"
              description="Your model provider accounts and write-only API keys."
            >
              <ProviderConnectionsCard />
            </Section>

            {/* Team */}
            <Section id="team" title="Team" description="People with access to this workspace.">
              <TeamCard />
            </Section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
