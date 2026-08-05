import {
  RiApps2AddLine,
  RiFocusMode,
  RiSendPlaneLine,
  RiTerminalBoxLine,
  type RemixiconComponentType,
} from "@remixicon/react";

import * as Button from "@/components/ui/button";

interface Artifact {
  name: string;
  summary: string;
  icon: RemixiconComponentType;
  time: string;
}

const artifacts: Artifact[] = [
  {
    name: "AI Landing Page",
    summary: "Modern marketing site for Skynet",
    icon: RiTerminalBoxLine,
    time: "1h ago",
  },
  {
    name: "Research Agent",
    summary: "Autonomous web research workflow",
    icon: RiSendPlaneLine,
    time: "5h ago",
  },
  {
    name: "Code Assistant",
    summary: "Terminal-first coding workspace",
    icon: RiTerminalBoxLine,
    time: "2d ago",
  },
  {
    name: "Meeting Notes",
    summary: "Product strategy and roadmap ideas",
    icon: RiFocusMode,
    time: "2d ago",
  },
  {
    name: "Prompt Library",
    summary: "Reusable prompts for AI tasks",
    icon: RiFocusMode,
    time: "2d ago",
  },
];

/**
 * A single artifact: a soft gray tile holding a white "mini-document" sheet
 * that bleeds off the tile's bottom edge (rounded top, clipped bottom), with
 * the artifact name and relative time sitting underneath.
 */
function ArtifactCard({ name, summary, icon: Icon, time }: Artifact) {
  return (
    <div>
      <div className="overflow-hidden rounded-2xl bg-bg-weak-50 px-4 pt-4">
        <div className="rounded-t-xl bg-bg-white-0 p-4 pb-6 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200">
          <Icon aria-hidden className="size-5 text-text-soft-400" />
          <p className="mt-3 truncate text-paragraph-sm text-text-soft-400">
            {summary}
          </p>
          <div className="mt-4 space-y-2">
            <div className="h-1.5 w-full rounded-full bg-bg-soft-200" />
            <div className="h-1.5 w-2/3 rounded-full bg-bg-soft-200" />
          </div>
        </div>
      </div>
      <p className="mt-3 text-label-sm text-text-strong-950">{name}</p>
      <p className="mt-0.5 text-paragraph-xs text-text-sub-600">{time}</p>
    </div>
  );
}

export function ArtifactsGallery() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <RiApps2AddLine aria-hidden className="size-5 text-text-strong-950" />
          <h1 className="text-display-sm text-text-strong-950">Artifacts</h1>
        </div>
        <Button.Root variant="neutral" mode="filled" className="rounded-full">
          New artifact
        </Button.Root>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2">
        {artifacts.map((artifact) => (
          <ArtifactCard key={artifact.name} {...artifact} />
        ))}
      </div>
    </div>
  );
}
