"use client";

import { RiRobot2Line } from "@remixicon/react";
import { useCapabilityCatalog } from "@/hooks/use-capability-catalog";
import { SidebarNavItem } from "./sidebar-nav";

/** Sidebar entry for /bots - rendered only when the server reports the surface on. */
export function BotsNavItem({ active }: { active: boolean }) {
  const { catalog } = useCapabilityCatalog();
  if (!catalog?.bots) return null;
  return <SidebarNavItem href="/bots" icon={RiRobot2Line} tone="blue" label="Bots" active={active} />;
}
