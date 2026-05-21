"use client";

import {
  RiAddLine,
  RiApps2Line,
  RiAppsLine,
  RiBook2Line,
  RiBookMarkedLine,
  RiBrainLine,
  RiCalendarScheduleLine,
  RiCodeSSlashLine,
  RiCornerDownLeftLine,
  RiDashboardLine,
  RiDatabase2Line,
  RiFlashlightLine,
  RiFlaskLine,
  RiGitPullRequestLine,
  RiKey2Line,
  RiLayoutGridLine,
  RiPenNibLine,
  RiPlugLine,
  RiPulseLine,
  RiSearch2Line,
  RiSettings3Line,
} from "@remixicon/react";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import type { ComponentType } from "react";
import * as React from "react";

import * as CommandMenu from "@/components/ui/command-menu";
import * as Kbd from "@/components/ui/kbd";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

type Cmd = {
  href: string;
  label: string;
  icon: IconComponent;
  group: "Threads" | "Library" | "Developer";
};

// Every skynet-a route surfaced by the ⌘K palette. `/code` and `/design` are
// still being built and 404 until they land. They remain listed because the shell
// contract so the palette is the canonical route index.
const COMMANDS: Cmd[] = [
  { href: "/agent/new", label: "New thread", icon: RiAddLine, group: "Threads" },
  { href: "/agent/runs", label: "Threads", icon: RiPulseLine, group: "Threads" },
  { href: "/agent/workspace", label: "All projects", icon: RiLayoutGridLine, group: "Threads" },

  { href: "/skills", label: "Skills", icon: RiFlashlightLine, group: "Library" },
  { href: "/playbooks", label: "Playbooks", icon: RiBookMarkedLine, group: "Library" },
  {
    href: "/agent/automations",
    label: "Automations",
    icon: RiCalendarScheduleLine,
    group: "Library",
  },
  { href: "/knowledge", label: "Knowledge", icon: RiBrainLine, group: "Library" },
  { href: "/memory", label: "Memory", icon: RiDatabase2Line, group: "Library" },
  { href: "/wiki", label: "Wiki", icon: RiBook2Line, group: "Library" },
  { href: "/apps", label: "Apps", icon: RiAppsLine, group: "Library" },
  { href: "/agent/artifacts", label: "Artifacts", icon: RiApps2Line, group: "Library" },
  { href: "/agent/plugins", label: "Plugins", icon: RiPlugLine, group: "Library" },
  { href: "/secrets", label: "Secrets", icon: RiKey2Line, group: "Library" },
  { href: "/settings", label: "Settings", icon: RiSettings3Line, group: "Library" },

  { href: "/dashboard", label: "Dashboard", icon: RiDashboardLine, group: "Developer" },
  { href: "/review", label: "Review", icon: RiGitPullRequestLine, group: "Developer" },
  { href: "/lab", label: "Component lab", icon: RiFlaskLine, group: "Developer" },
  { href: "/code", label: "Code", icon: RiCodeSSlashLine, group: "Developer" },
  { href: "/design", label: "Design", icon: RiPenNibLine, group: "Developer" },
];

const GROUP_ORDER: Cmd["group"][] = ["Threads", "Library", "Developer"];

/**
 * The top-nav search pill + the ⌘K command palette it opens. Client-side so it
 * can own the open state, the global ⌘K / Ctrl+K shortcut, and router
 * navigation. Built on the vendored AlignUI CommandMenu (cmdk + Modal), which
 * supplies the portal, backdrop, focus trap, and Esc-to-close for free.
 */
export function SearchCommand() {
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
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-text-soft-400 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
      >
        <RiSearch2Line className="size-3.5 shrink-0" aria-hidden />
        <span className="flex-1 text-left text-paragraph-sm">Search</span>
        <Kbd.Root className="ml-auto">⌘K</Kbd.Root>
      </button>

      <CommandMenu.Dialog
        open={open}
        onOpenChange={handleOpenChange}
        overlayClassName="backdrop-blur-[3px]"
        className="max-h-[70vh] w-[min(92vw,40rem)]"
      >
        <div className="group/cmd-input flex items-center gap-2.5 px-5">
          <RiSearch2Line className="size-5 shrink-0 text-text-soft-400" aria-hidden />
          <CommandMenu.Input
            className="h-14"
            placeholder="Type a command"
            value={search}
            onValueChange={setSearch}
          />
        </div>

        <CommandMenu.List>
          <Command.Empty className="px-5 py-8 text-center text-paragraph-sm text-text-soft-400">
            No commands found
          </Command.Empty>
          {GROUP_ORDER.map((group) => (
            <CommandMenu.Group key={group} heading={group}>
              {COMMANDS.filter((c) => c.group === group).map((cmd) => (
                <CommandMenu.Item key={cmd.href} value={cmd.label} onSelect={() => go(cmd.href)}>
                  <CommandMenu.ItemIcon as={cmd.icon} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                </CommandMenu.Item>
              ))}
            </CommandMenu.Group>
          ))}
        </CommandMenu.List>

        <CommandMenu.Footer>
          <span className="text-paragraph-xs text-text-sub-600">
            {matchCount} {matchCount === 1 ? "command" : "commands"}
          </span>
          <div className="flex items-center gap-1.5 text-paragraph-xs text-text-soft-400">
            <Kbd.Root>
              <RiCornerDownLeftLine className="size-3" aria-hidden />
            </Kbd.Root>
            <span>select</span>
            <Kbd.Root>esc</Kbd.Root>
            <span>close</span>
          </div>
        </CommandMenu.Footer>
      </CommandMenu.Dialog>
    </>
  );
}
