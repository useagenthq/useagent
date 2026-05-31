"use client";

import {
  RiAddLine,
  RiApps2Line,
  RiAppsLine,
  RiBook2Line,
  RiBookMarkedLine,
  RiBrainLine,
  RiCalendarScheduleLine,
  RiCornerDownLeftLine,
  RiDashboardLine,
  RiDatabase2Line,
  RiFlashlightLine,
  RiFlaskLine,
  RiGitPullRequestLine,
  RiKey2Line,
  RiPlugLine,
  RiPulseLine,
  RiSearch2Line,
  RiSettings3Line,
} from "@remixicon/react";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import type { ComponentType } from "react";
import * as React from "react";

import { Kbd } from "@/components/base/kbd/kbd";
import * as CommandMenu from "@/components/ui/command-menu";
import { cx } from "@/utils/cx";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

type Cmd = {
  href: string;
  label: string;
  icon: IconComponent;
  group: "Threads" | "Customize" | "Developer";
};

// Every supported skynet-a route surfaced by the ⌘K palette.
const COMMANDS: Cmd[] = [
  { href: "/agent/new", label: "New thread", icon: RiAddLine, group: "Threads" },
  { href: "/agent/runs", label: "Threads", icon: RiPulseLine, group: "Threads" },

  { href: "/skills", label: "Skills", icon: RiFlashlightLine, group: "Customize" },
  { href: "/playbooks", label: "Playbooks", icon: RiBookMarkedLine, group: "Customize" },
  {
    href: "/agent/automations",
    label: "Automations",
    icon: RiCalendarScheduleLine,
    group: "Customize",
  },
  { href: "/knowledge", label: "Knowledge", icon: RiBrainLine, group: "Customize" },
  { href: "/memory", label: "Memory", icon: RiDatabase2Line, group: "Customize" },
  { href: "/wiki", label: "Wiki", icon: RiBook2Line, group: "Customize" },
  { href: "/apps", label: "Apps", icon: RiAppsLine, group: "Customize" },
  { href: "/agent/artifacts", label: "Artifacts", icon: RiApps2Line, group: "Customize" },
  { href: "/agent/plugins", label: "Plugins", icon: RiPlugLine, group: "Customize" },
  { href: "/secrets", label: "Secrets", icon: RiKey2Line, group: "Customize" },
  { href: "/settings", label: "Settings", icon: RiSettings3Line, group: "Customize" },

  { href: "/dashboard", label: "Dashboard", icon: RiDashboardLine, group: "Developer" },
  { href: "/review", label: "Review", icon: RiGitPullRequestLine, group: "Developer" },
  { href: "/lab", label: "Component lab", icon: RiFlaskLine, group: "Developer" },
];

const GROUP_ORDER: Cmd["group"][] = ["Threads", "Customize", "Developer"];

/**
 * The sidebar quick-search pill (BoardUI dashboard-sidebar treatment) + the ⌘K
 * command palette it opens. Client-side so it can own the open state, the
 * global ⌘K / Ctrl+K shortcut, and router navigation. Built on the vendored
 * AlignUI CommandMenu (cmdk + Modal) for behavior — portal, backdrop, focus
 * trap, Esc-to-close — with its visible surfaces restyled on BoardUI tokens.
 */
export function SearchCommand({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  // Global ⌘K / Ctrl+K toggles the palette from anywhere.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSearch("");
  }

  function go(href: string) {
    handleOpenChange(false);
    router.push(href);
  }

  const query = search.trim().toLowerCase();
  const matchCount = query
    ? COMMANDS.filter((c) => c.label.toLowerCase().includes(query)).length
    : COMMANDS.length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={compact ? "Search" : undefined}
        title={compact ? "Search" : undefined}
        className={cx(
          "flex cursor-pointer items-center rounded-full bg-background-tertiary-default text-text-secondary outline-none transition-colors hover:bg-background-tertiary-hover/55 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          compact ? "size-9 justify-center" : "mb-2 w-full gap-2 px-2.5 py-2",
        )}
      >
        <RiSearch2Line className="size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
        {!compact && <span className="flex-1 text-left text-body-2-medium">Search</span>}
        {!compact && <Kbd className="ml-auto">⌘K</Kbd>}
      </button>

      <CommandMenu.Dialog
        open={open}
        onOpenChange={handleOpenChange}
        overlayClassName="backdrop-blur-[3px]"
        className="max-h-[70vh] w-[min(92vw,40rem)] border border-border-button-default bg-background-primary-default"
      >
        <div className="group/cmd-input flex items-center gap-2.5 px-5">
          <RiSearch2Line className="size-5 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <CommandMenu.Input
            className="h-14 text-text-primary placeholder:text-text-tertiary"
            placeholder="Type a command"
            value={search}
            onValueChange={setSearch}
          />
        </div>

        <CommandMenu.List>
          <Command.Empty className="px-5 py-8 text-center text-body-2-regular text-text-tertiary">
            No commands found
          </Command.Empty>
          {GROUP_ORDER.map((group) => (
            <CommandMenu.Group
              key={group}
              heading={group}
              className="[&>[cmdk-group-heading]]:text-text-tertiary"
            >
              {COMMANDS.filter((c) => c.group === group).map((cmd) => (
                <CommandMenu.Item
                  key={cmd.href}
                  value={cmd.label}
                  onSelect={() => go(cmd.href)}
                  className="bg-transparent text-text-primary data-[selected=true]:bg-background-primary-hover"
                >
                  <CommandMenu.ItemIcon
                    as={cmd.icon}
                    className="text-foreground-icon-secondary"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                </CommandMenu.Item>
              ))}
            </CommandMenu.Group>
          ))}
        </CommandMenu.List>

        <CommandMenu.Footer>
          <span className="text-caption-1-regular text-text-secondary">
            {matchCount} {matchCount === 1 ? "command" : "commands"}
          </span>
          <div className="flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
            <Kbd>
              <RiCornerDownLeftLine className="size-3" aria-hidden />
            </Kbd>
            <span>select</span>
            <Kbd>esc</Kbd>
            <span>close</span>
          </div>
        </CommandMenu.Footer>
      </CommandMenu.Dialog>
    </>
  );
}
