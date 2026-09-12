"use client";

import { useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { AvatarMark } from "./avatar-mark";
import { NewBotDialog } from "./new-bot-dialog";

const CLUSTER = [
  { tone: "violet", icon: "research", className: "top-0 left-8" },
  { tone: "amber", icon: "megaphone", className: "top-6 right-4" },
  { tone: "emerald", icon: "chart", className: "bottom-8 left-0" },
  { tone: "blue", icon: "code", className: "bottom-0 right-12" },
  { tone: "rose", icon: "sales", className: "top-14 left-28" },
] as const;

/** The reference's first screen: floating marks, one line, one button. */
export function BotsOnboarding() {
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="relative h-36 w-48" aria-hidden>
        {CLUSTER.map((mark) => (
          <AvatarMark key={mark.icon} tone={mark.tone} icon={mark.icon} size="size-10" className={`absolute ${mark.className}`} />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-display-sm text-text-primary">Your team of always-on bots</h2>
        <p className="max-w-sm text-body-regular text-text-secondary">
          Each one has a job, its own computer, and a thread that never resets.
        </p>
      </div>
      <Button variant="primary" size="medium" onClick={() => setCreating(true)}>
        Create bot
      </Button>
      <NewBotDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
