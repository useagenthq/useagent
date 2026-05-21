import {
  RiAppsLine,
  RiBook2Line,
  RiBookMarkedLine,
  RiBrainLine,
  RiBroadcastLine,
  RiCalendarScheduleLine,
  RiDatabase2Line,
  RiFlashlightLine,
  RiKey2Line,
  RiPlugLine,
  RiSettings3Line,
  RiStackLine,
} from "@remixicon/react";
import { SearchCommand } from "./search-command";
import { SidebarBrand } from "./sidebar-brand";
import { Sidebar, SidebarNavItem, SidebarSectionLabel } from "./sidebar-nav";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

export type LibrarySidebarActive =
  | "skills"
  | "playbooks"
  | "automations"
  | "knowledge"
  | "memory"
  | "wiki"
  | "apps"
  | "artifacts"
  | "plugins"
  | "secrets"
  | "settings";

const LIBRARY_ITEMS = [
  { key: "skills", href: "/skills", icon: RiFlashlightLine, label: "Skills" },
  { key: "playbooks", href: "/playbooks", icon: RiBookMarkedLine, label: "Playbooks" },
  {
    key: "automations",
    href: "/agent/automations",
    icon: RiCalendarScheduleLine,
    label: "Automations",
  },
  { key: "knowledge", href: "/knowledge", icon: RiBrainLine, label: "Knowledge" },
  { key: "memory", href: "/memory", icon: RiDatabase2Line, label: "Memory" },
  { key: "wiki", href: "/wiki", icon: RiBook2Line, label: "Wiki" },
  { key: "apps", href: "/apps", icon: RiAppsLine, label: "Apps" },
  { key: "artifacts", href: "/agent/artifacts", icon: RiBroadcastLine, label: "Artifacts" },
  { key: "plugins", href: "/agent/plugins", icon: RiPlugLine, label: "Plugins" },
  { key: "secrets", href: "/secrets", icon: RiKey2Line, label: "Secrets" },
] as const;

export function LibrarySidebar({ active }: { active?: LibrarySidebarActive }) {
  return (
    <Sidebar
      ariaLabel="Library navigation"
      header={<SidebarBrand label="Library" />}
      footer={
        <nav aria-label="Library utilities" className="p-3">
          <SidebarNavItem
            href="/settings"
            icon={RiSettings3Line}
            label="Settings"
            active={active === "settings"}
          />
          <div className="mt-2 flex items-center justify-between px-2">
            <UserMenu />
            <ThemeToggle />
          </div>
        </nav>
      }
    >
      <SearchCommand />
      <SidebarNavItem href="/agent/runs" icon={RiStackLine} label="Workspace" />
      <SidebarSectionLabel>Library</SidebarSectionLabel>
      {LIBRARY_ITEMS.map((item) => (
        <SidebarNavItem
          key={item.key}
          href={item.href}
          icon={item.icon}
          label={item.label}
          active={active === item.key}
        />
      ))}
    </Sidebar>
  );
}
