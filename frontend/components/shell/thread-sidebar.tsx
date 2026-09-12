"use client";

import {
  RiAddLine,
  RiArchiveLine,
  RiBookOpenLine,
  RiBookShelfLine,
  RiBrainLine,
  RiChat3Line,
  RiDashboardLine,
  RiKey2Line,
  RiListCheck2,
  RiRobot2Line,
} from "@remixicon/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { runTitle } from "@/components/chat/types";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/sidebar-kit/sidebar";
import { AppSidebarFrame, NavRoutes, type Route } from "./app-sidebar-frame";
import { SidebarProjects } from "./sidebar-projects";
import { useSidebarThreads } from "./sidebar-threads-provider";
import { WorkingProjectStatus } from "./working-project-status";

export type ThreadSidebarActive = "new" | "dashboard" | "bots" | "library" | "settings";

/** Icon-rail stand-in for the thread tree: the six most recent threads with tooltips. */
function CollapsedThreads() {
  const pathname = usePathname();
  const runs = useSidebarThreads();
  return (
    <SidebarGroup>
      <SidebarMenu>
        {runs.slice(0, 6).map((run) => {
          const href = `/session/${run.id}`;
          return (
            <SidebarMenuItem key={run.id}>
              <SidebarMenuButton
                className="justify-center text-muted-foreground hover:bg-sidebar-muted hover:text-foreground"
                isActive={pathname === href}
                render={<Link href={href} />}
                tooltip={runTitle(run.prompt)}
              >
                <RiChat3Line className="size-4" aria-hidden />
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * The thread rail: the app sidebar frame around the product's own project
 * thread tree. The tree keeps everything the previous rail had - folders,
 * nested delegated children, status dots, per-project actions and the
 * "Show N more" disclosures - because it is the same component.
 */
export function ThreadSidebar({ active }: { active?: ThreadSidebarActive }) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  const routes: Route[] = [
    {
      id: "new",
      title: "New thread",
      icon: <RiAddLine className="size-4" aria-hidden />,
      href: "/agent/new",
      active: active === "new",
    },
    {
      id: "dashboard",
      title: "Dashboard",
      icon: <RiDashboardLine className="size-4" aria-hidden />,
      href: "/dashboard",
      active: active === "dashboard",
      trailing: <WorkingProjectStatus />,
    },
    {
      id: "bots",
      title: "Bots",
      icon: <RiRobot2Line className="size-4" aria-hidden />,
      href: "/bots",
      active: active === "bots",
    },
    {
      id: "customize",
      title: "Customize",
      icon: <RiBookOpenLine className="size-4" aria-hidden />,
      href: "/skills",
      active: active === "library",
    },
    {
      id: "library",
      title: "Library",
      icon: <RiBookShelfLine className="size-4" aria-hidden />,
      href: "/artifacts",
      subs: [
        {
          title: "Artifacts",
          href: "/artifacts",
          icon: <RiArchiveLine className="size-4" aria-hidden />,
        },
        { title: "Tasks", href: "/tasks", icon: <RiListCheck2 className="size-4" aria-hidden /> },
        { title: "Memory", href: "/memory", icon: <RiBrainLine className="size-4" aria-hidden /> },
        { title: "Secrets", href: "/secrets", icon: <RiKey2Line className="size-4" aria-hidden /> },
      ],
    },
  ];

  return (
    <AppSidebarFrame>
      <NavRoutes routes={routes} />
      {isCollapsed ? <CollapsedThreads /> : <SidebarProjects />}
    </AppSidebarFrame>
  );
}
