import {
  RiAddLine,
  RiFlowChart,
  RiGithubFill,
  RiGoogleFill,
  RiImageLine,
  RiInstagramFill,
  RiLinkedinFill,
  RiQuillPenLine,
  RiSearchEyeLine,
} from "@remixicon/react";
import type { Metadata } from "next";
import type { ComponentType } from "react";
import * as Button from "@/components/ui/button";
import * as Switch from "@/components/ui/switch";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";

export const metadata: Metadata = {
  title: "Plugins",
  description: "Triggers and skills available to your agents.",
};

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

const triggers: { icon: IconComponent; name: string }[] = [
  { icon: RiGoogleFill, name: "Google" },
  { icon: RiInstagramFill, name: "Instagram" },
  { icon: RiGithubFill, name: "GitHub" },
  { icon: RiLinkedinFill, name: "LinkedIn" },
  { icon: RiSearchEyeLine, name: "Web Search" },
  { icon: RiFlowChart, name: "Run Workflow" },
];

const skills: { icon: IconComponent; name: string }[] = [
  { icon: RiImageLine, name: "image-generation" },
  { icon: RiQuillPenLine, name: "article-writing" },
];

function PluginRow({ icon: Icon, name, mono }: { icon: IconComponent; name: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Icon className="size-5 shrink-0 text-text-sub-600" aria-hidden />
      <span
        className={
          mono
            ? "flex-1 font-mono text-label-xs text-text-strong-950"
            : "flex-1 text-label-sm text-text-strong-950"
        }
      >
        {name}
      </span>
      <Switch.Root defaultChecked aria-label={name} />
    </div>
  );
}

function SectionHeader({ title, addLabel }: { title: string; addLabel: string }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-label-sm text-text-sub-600">{title}</h2>
      <Button.Root className="rounded-full" variant="neutral" mode="ghost" size="xsmall" aria-label={addLabel}>
        <Button.Icon as={RiAddLine} />
      </Button.Root>
    </div>
  );
}

export default function AgentPluginsPage() {
  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="plugins" />}>
      <div className="flex justify-center p-6 lg:p-12">
        <div className="w-full max-w-sm">
          <h1 className="sr-only">Plugins</h1>
          <div className="rounded-2xl border border-stroke-soft-200 bg-bg-white-0 px-5 py-4 shadow-regular-sm">
            <SectionHeader title="Triggers" addLabel="Add trigger" />
            <div className="mt-1">
              {triggers.map(({ icon, name }) => (
                <PluginRow key={name} icon={icon} name={name} />
              ))}
            </div>

            <div className="my-4 border-t border-stroke-soft-200" />

            <SectionHeader title="Skills" addLabel="Add skill" />
            <div className="mt-1">
              {skills.map(({ icon, name }) => (
                <PluginRow key={name} icon={icon} name={name} mono />
              ))}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
