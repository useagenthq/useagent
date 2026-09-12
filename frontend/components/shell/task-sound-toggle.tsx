"use client";

import { RiVolumeMuteLine, RiVolumeUpLine } from "@remixicon/react";
import { useSyncExternalStore } from "react";

import { taskSoundsPreference } from "@/lib/task-sounds";
import { taskSounds } from "@/lib/task-sounds-player";

export function useTaskSoundsEnabled(): boolean {
  return useSyncExternalStore(
    taskSoundsPreference.subscribe,
    taskSoundsPreference.enabled,
    () => true,
  );
}

/**
 * The sidebar's task-sounds switch, beside the theme toggle: on, a settled
 * turn rings; off, the shell is silent. Turning it on plays the finish cue,
 * which also unlocks audio for the page since it happens on a click.
 */
export function TaskSoundToggle() {
  const enabled = useTaskSoundsEnabled();
  const label = enabled ? "Turn task sounds off" : "Turn task sounds on";
  const Icon = enabled ? RiVolumeUpLine : RiVolumeMuteLine;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={enabled}
      title={label}
      className="flex size-9 shrink-0 items-center justify-center rounded-2lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      onClick={() => {
        const next = !enabled;
        taskSoundsPreference.set(next);
        if (next) void taskSounds.moment("done-here", `toggle:${crypto.randomUUID()}`);
      }}
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}
