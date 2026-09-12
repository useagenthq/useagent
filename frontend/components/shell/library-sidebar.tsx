"use client";

import {
  type RemixiconComponentType,
  RiAppsLine,
  RiBook2Line,
  RiBookMarkedLine,
  RiBrainLine,
  RiBroadcastLine,
  RiCalendarScheduleLine,
  RiDatabase2Line,
  RiFlashlightLine,
  RiGitPullRequestLine,
  RiKey2Line,
  RiLightbulbLine,
  RiListCheck2,
  RiPlugLine,
  RiStackLine,
} from "@remixicon/react";
import { useRailFolded } from "@/components/shell/rail-folded";

import { AppSidebarFrame, NavRoutes, type Route } from "./app-sidebar-frame";
import { SidebarSectionLabel } from "./sidebar-nav";

export type LibrarySidebarActive =
  | "skills"
  | "playbooks"
  | "automations"
  | "knowledge"
  | "memory"
  | "learnings"
  | "wiki"
  | "reviews"
  | "apps"
  | "artifacts"
  | "plugins"
  | "tasks"
  | "secrets"
  | "settings";

const LIBRARY_ITEMS: {
  key: LibrarySidebarActive;
  href: string;
  icon: RemixiconComponentType;
  label: string;
}[] = [
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
  { key: "learnings", href: "/learnings", icon: RiLightbulbLine, label: "Learnings" },
  { key: "wiki", href: "/wiki", icon: RiBook2Line, label: "Wiki" },
  { key: "reviews", href: "/review", icon: RiGitPullRequestLine, label: "Reviews" },
  { key: "apps", href: "/apps", icon: RiAppsLine, label: "Apps" },
  { key: "artifacts", href: "/agent/artifacts", icon: RiBroadcastLine, label: "Artifacts" },
  { key: "plugins", href: "/agent/plugins", icon: RiPlugLine, label: "Plugins" },
  { key: "tasks", href: "/tasks", icon: RiListCheck2, label: "Tasks" },
  { key: "secrets", href: "/secrets", icon: RiKey2Line, label: "Secrets" },
];

/** The Customize rail, in the same frame as the thread rail. */
export function LibrarySidebar({ active }: { active?: LibrarySidebarActive }) {
  const isCollapsed = useRailFolded();

  const back: Route[] = [
    { id: "all-threads", title: "All threads", icon: RiStackLine, href: "/agent/runs" },
  ];
  const items: Route[] = LIBRARY_ITEMS.map((item) => ({
    id: item.key,
    title: item.label,
    icon: item.icon,
    href: item.href,
    active: active === item.key,
  }));

  return (
    <AppSidebarFrame label="Customize">
      <NavRoutes routes={back} />
      {!isCollapsed && <SidebarSectionLabel>Customize</SidebarSectionLabel>}
      <NavRoutes routes={items} />
    </AppSidebarFrame>
  );
}
