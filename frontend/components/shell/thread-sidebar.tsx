import {
  RiAddLine,
  RiBarChartBoxLine,
  RiBookMarkedLine,
  RiFolderLine,
  RiSettings3Line,
} from "@remixicon/react";

import { SearchCommand } from "./search-command";
import { SidebarBrand } from "./sidebar-brand";
import { Sidebar, SidebarNavItem } from "./sidebar-nav";
import { SidebarProjects } from "./sidebar-projects";
import { SidebarThreads } from "./sidebar-threads";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { WorkingProjectStatus } from "./working-project-status";

export type ThreadSidebarActive = "new" | "projects" | "usage" | "library" | "settings";

function ThreadSidebarFooter({ active }: { active?: ThreadSidebarActive }) {
  return (
    <nav aria-label="Workspace utilities" className="p-3">
      <SidebarNavItem
        href="/settings#usage"
        icon={RiBarChartBoxLine}
        label="Usage"
        active={active === "usage"}
      />
      <SidebarNavItem
        href="/skills"
        icon={RiBookMarkedLine}
        label="Library"
        active={active === "library"}
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
        label="New thread"
        active={active === "new"}
      />
      <SidebarNavItem
        href="/agent/workspace"
        icon={RiFolderLine}
        label="All projects"
        active={active === "projects"}
        trailing={<WorkingProjectStatus />}
      />
      <SidebarProjects />
      <SidebarThreads />
    </Sidebar>
  );
}
