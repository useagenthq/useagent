import {
  RiAddLine,
  RiBarChartBoxLine,
  RiBookShelfLine,
  RiDashboardLine,
  RiSettings3Line,
} from "@remixicon/react";

import { SearchCommand } from "./search-command";
import { SidebarBrand } from "./sidebar-brand";
import { Sidebar, SidebarNavItem } from "./sidebar-nav";
import { SidebarProjects } from "./sidebar-projects";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { WorkingProjectStatus } from "./working-project-status";

export type ThreadSidebarActive = "new" | "dashboard" | "usage" | "library" | "settings";

function ThreadSidebarFooter({ active }: { active?: ThreadSidebarActive }) {
  return (
    <nav aria-label="Workspace utilities" className="p-2">
      <SidebarNavItem
        href="/settings#usage"
        icon={RiBarChartBoxLine}
        label="Usage"
        active={active === "usage"}
      />
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
  );
}

export function ThreadSidebar({ active }: { active?: ThreadSidebarActive }) {
  return (
    <Sidebar
      ariaLabel="Thread navigation"
      header={<SidebarBrand />}
      footer={<ThreadSidebarFooter active={active} />}
    >
      <SearchCommand />
      <SidebarNavItem
        href="/agent/new"
        icon={RiAddLine}
        tone="primary"
        label="New thread"
        active={active === "new"}
      />
      <SidebarNavItem
        href="/dashboard"
        icon={RiDashboardLine}
        tone="purple"
        label="Dashboard"
        active={active === "dashboard"}
        trailing={<WorkingProjectStatus />}
      />
      <SidebarNavItem
        href="/skills"
        icon={RiBookShelfLine}
        tone="green"
        label="Customize"
        active={active === "library"}
      />
      <SidebarProjects />
    </Sidebar>
  );
}
