"use client";

import { useState } from "react";
import { AgentScreen } from "@/components/ai/agent-screen";
import { Button } from "@/components/base/buttons/button";

/** Stand-in for the live desktop frame: a window on a plain wallpaper. */
function SampleDesktop() {
  return (
    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,var(--color-blue-400),var(--color-neutral-900)_70%)] p-[8%]">
      <div className="flex h-full flex-col overflow-hidden rounded-lg bg-background-primary-default shadow-dropdown">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border-button-default bg-background-secondary-default px-2.5 py-1.5">
          <span className="size-2 rounded-full bg-status-rose-text" />
          <span className="size-2 rounded-full bg-status-yellow-text" />
          <span className="size-2 rounded-full bg-status-lime-text" />
          <span className="ml-2 h-1.5 w-16 rounded-full bg-border-button-default" />
        </div>
        <div className="flex flex-1 flex-col gap-2.5 p-3">
          {["w-2/5", "w-3/5", "w-1/3", "w-1/2"].map((w) => (
            <div key={w} className="flex items-center gap-2.5">
              <span className="size-5 shrink-0 rounded-full bg-status-blue-background" />
              <span className={`h-1.5 rounded-full bg-border-button-default ${w}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The two resting states side by side; the second one opens into the viewer. */
export function AgentScreenShowcase() {
  const [open, setOpen] = useState(false);
  const [controlled, setControlled] = useState(false);
  return (
    <div data-lab="agent-screen" className="grid gap-6 sm:grid-cols-2">
      <AgentScreen
        agentName="Nova"
        status="loading"
        loading
        loadingCaption="No active sandbox. Send a message to start one."
        screen={null}
        open={false}
        onOpenChange={() => {}}
      />
      <AgentScreen
        agentName="Nova"
        status="working"
        screen={<SampleDesktop />}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setControlled(false);
        }}
        controls={
          <Button
            variant="secondary"
            size="small"
            aria-pressed={controlled}
            onClick={() => setControlled((value) => !value)}
            className="rounded-full"
          >
            {controlled ? "Release control" : "Take control"}
          </Button>
        }
      />
    </div>
  );
}
