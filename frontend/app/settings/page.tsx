import { RiCameraLine, RiPencilLine } from "@remixicon/react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { ApiKeysCard } from "./api-keys-card";
import { GeneralCard } from "./general-card";
import { IntegrationConnections } from "./integration-connections";
import { ProviderConnectionsCard } from "./provider-connections-card";
import { SecretsCard } from "./secrets-card";
import { SettingsRail } from "./settings-rail";
import { SettingsCard, SettingsRow } from "./settings-rows";
import { TeamCard } from "./team-card";
import { UsageMeters } from "./usage-meters";

export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your workspace, usage, machine snapshots, secrets, and team.",
};

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
      <div className="rounded-2xl border border-border-button-default bg-background-primary-default p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-0.5">
          <h2 className="text-headline-medium text-text-primary">{title}</h2>
          {description && (
            <p className="text-caption-1-regular text-text-secondary">{description}</p>
          )}
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
    <AppShell sidebar={<ThreadSidebar active="settings" />}>
      <div className="w-full min-w-0 px-6 py-8 lg:px-10">
        <h1 className="text-display-4-medium text-text-primary">Settings</h1>

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
            <Section
              id="usage"
              title="Usage"
              description="Your plan and model consumption this cycle."
            >
              <SettingsCard className="mb-4">
                <SettingsRow label="Plan" description="Free while you get started.">
                  <Chip variant="caption" color="soft">
                    Starter - Free
                  </Chip>
                </SettingsRow>
              </SettingsCard>

              {/* Real per-model token burn from GET /api/fleet (same live source
                  as the workspace Limits card). No credits meter - there is no
                  billing/credit system yet, so a fabricated "N / 2,000 credits"
                  bar was removed rather than faked. */}
              <UsageMeters />
            </Section>

            {/* Machine */}
            <Section
              id="machine"
              title="Machine"
              description="The saved VM state new sessions boot from."
            >
              <div className="flex flex-col gap-3 rounded-xl border border-border-button-default bg-background-secondary-default p-4">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-md bg-background-primary-default px-2 py-0.5 font-mono text-[0.6875rem] text-text-secondary ring-1 ring-inset ring-border-button-default">
                    snapshot-2026-07-24
                  </span>
                </div>
                <p className="text-caption-1-regular text-text-secondary">
                  Node 24 · pnpm · Playwright
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="rounded-full"
                    variant="secondary"
                    size="xs"
                    leadingIcon={RiPencilLine}
                  >
                    Edit machine
                  </Button>
                  <Button
                    className="rounded-full"
                    variant="primary"
                    size="xs"
                    leadingIcon={RiCameraLine}
                  >
                    New snapshot
                  </Button>
                </div>
              </div>
            </Section>

            {/* Integrations */}
            <Section
              id="integrations"
              title="Integrations"
              description="Connected tools agents can use for this workspace."
            >
              <IntegrationConnections />
            </Section>

            {/* Provider connections */}
            <Section
              id="providers"
              title="Provider connections"
              description="Your model provider accounts and write-only API keys."
            >
              <ProviderConnectionsCard />
            </Section>

            {/* Secrets */}
            <Section
              id="secrets"
              title="Secrets"
              description="Persisted for every future session on this workspace."
            >
              <SecretsCard />
            </Section>

            {/* API keys */}
            <Section
              id="apikeys"
              title="API keys"
              description="Bearer keys that let a local script dispatch and read runs for this workspace."
            >
              <ApiKeysCard />
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
