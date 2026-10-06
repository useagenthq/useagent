"use client";

// The composer send row's run location menu, desktop app only: where a new
// thread runs, "Local" (this machine, under the name it enrolled with) or
// "Cloud", with a check on the active entry and a shortcut to switch. The
// choice rides POST /api/runs as `run_location` on the root run; a reply
// inherits its thread's, so a reply composer never shows this. The web app has
// no bridge and therefore no menu: it always runs on the cloud. The model
// (the default, the toggle, the shortcut, the hint) is exported on its own so
// the composer's wiring can be tested without a browser.

import { RiArrowDropDownLine, RiCheckLine, RiCloudLine, RiComputerLine } from "@remixicon/react";
import type { RunLocation } from "@useagent/agent-client/wire";
import { useEffect, useState } from "react";
import {
  Dropdown,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { cx } from "@/utils/cx";
import { type DesktopRunnerStatus, localRunnerAvailable, machineLabel, type UseAgentDesktopBridge } from "./desktop-bridge";

export type { RunLocation };

const FACES: Record<RunLocation, { readonly label: string; readonly icon: typeof RiCloudLine }> = {
  local: { label: "Local", icon: RiComputerLine },
  cloud: { label: "Cloud", icon: RiCloudLine },
};

/** Local when this machine's runner can take work, Cloud otherwise (and before the status is known). */
export function defaultRunLocation(status: DesktopRunnerStatus | null): RunLocation {
  return status?.state === "online" ? "local" : "cloud";
}

/** The status is settled once the runner is past starting up; the default is
 *  taken from a settled status only, so a machine still coming up lands on
 *  Local rather than being fixed on Cloud by its first report. */
export function runnerStatusSettled(status: DesktopRunnerStatus | null): status is DesktopRunnerStatus {
  return status !== null && status.state !== "starting" && status.state !== "pulling";
}

/** The location a submission carries: the person's choice, else, in the desktop
 *  app, the Cloud the menu shows before its default has settled. Pinned into
 *  the composer's state at the first submission, so a retry of a lost response
 *  builds the same body and reuses its key instead of opening a second thread;
 *  the web app has no menu and carries nothing. */
export function submittedRunLocation(choice: RunLocation | null, desktop: boolean): RunLocation | null {
  return choice ?? (desktop ? "cloud" : null);
}

export function toggledRunLocation(location: RunLocation): RunLocation {
  return location === "local" ? "cloud" : "local";
}

/** The switch shortcut: the platform's command key with the apostrophe. */
export function isRunLocationShortcut(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): boolean {
  return event.key === "'" && (event.metaKey || event.ctrlKey);
}

export function runLocationShortcutHint(platform: UseAgentDesktopBridge["platform"]): string {
  return platform === "darwin" ? "Use ⌘' to switch" : "Use Ctrl+' to switch";
}

/** The menu's entries on their own, so they render without the popover. */
export function RunLocationPanel({
  location,
  onChange,
  machineName,
  machineOnline,
  platform,
}: {
  location: RunLocation;
  onChange: (location: RunLocation) => void;
  machineName: string;
  machineOnline: boolean;
  platform: UseAgentDesktopBridge["platform"];
}) {
  const entries: ReadonlyArray<{ location: RunLocation; description: string }> = [
    { location: "local", description: machineOnline ? machineName : `${machineName}, not connected` },
    { location: "cloud", description: "A hosted computer" },
  ];
  return (
    <>
      {entries.map((entry) => {
        const face = FACES[entry.location];
        const active = location === entry.location;
        return (
          <DropdownItem key={entry.location} selected={active} onSelect={() => onChange(entry.location)}>
            <face.icon className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col text-left">
              <span className="text-body-2-medium text-text-primary">{face.label}</span>
              <span className="truncate text-caption-1-regular text-text-secondary">{entry.description}</span>
            </span>
            {active && (
              <RiCheckLine
                data-testid="run-location-check"
                className="size-4 shrink-0 text-foreground-icon-secondary"
                aria-hidden
              />
            )}
          </DropdownItem>
        );
      })}
      <p className="px-2 pt-1 pb-1.5 text-caption-1-regular text-text-tertiary">
        {runLocationShortcutHint(platform)}
      </p>
    </>
  );
}

export interface RunLocationMenuProps {
  /** The desktop bridge; null (the web app) renders nothing. */
  bridge: UseAgentDesktopBridge | null;
  /** The composer's choice; null until the menu has picked the default from this machine's runner status. */
  location: RunLocation | null;
  onChange: (location: RunLocation) => void;
  disabled?: boolean;
  className?: string;
}

/** The send-row control: the current location, opening the two entries above it. */
export function RunLocationMenu({ bridge, location, onChange, disabled = false, className }: RunLocationMenuProps) {
  const [status, setStatus] = useState<DesktopRunnerStatus | null>(null);
  // Read the runner's status once, then keep reading while it is still
  // starting, so the default lands on Local the moment the machine can take work.
  useEffect(() => {
    if (!bridge || !localRunnerAvailable(bridge.platform)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await bridge.runnerStatus();
        if (cancelled) return;
        setStatus(next);
        if (next.state === "starting" || next.state === "pulling") timer = setTimeout(poll, 750);
      } catch {
        if (!cancelled) setStatus({ state: "error", detail: "Could not read runner status." });
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bridge]);
  // The default is chosen once, when the status has settled; a pick sticks.
  useEffect(() => {
    if (bridge && localRunnerAvailable(bridge.platform) && location === null && runnerStatusSettled(status)) {
      onChange(defaultRunLocation(status));
    }
  }, [bridge, status, location, onChange]);
  useEffect(() => {
    if (!bridge || !localRunnerAvailable(bridge.platform) || disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isRunLocationShortcut(event)) return;
      event.preventDefault();
      onChange(toggledRunLocation(location ?? defaultRunLocation(status)));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [bridge, disabled, location, status, onChange]);
  if (!bridge || !localRunnerAvailable(bridge.platform)) return null;
  const current = location ?? defaultRunLocation(status);
  const face = FACES[current];
  return (
    <Dropdown>
      <DropdownTrigger
        aria-label={`Run location: ${face.label}`}
        isDisabled={disabled}
        className={cx("flex items-center gap-1 rounded-lg", disabled && "cursor-default opacity-60", className)}
      >
        <face.icon className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="flex items-center">
          <span className="whitespace-nowrap text-body-2-medium text-text-secondary">{face.label}</span>
          <RiArrowDropDownLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        </span>
      </DropdownTrigger>
      <DropdownPopover aria-label="Run location" placement="top end" className="w-[280px]">
        <RunLocationPanel
          location={current}
          onChange={onChange}
          machineName={machineLabel(bridge.platform)}
          machineOnline={status?.state === "online"}
          platform={bridge.platform}
        />
      </DropdownPopover>
    </Dropdown>
  );
}
