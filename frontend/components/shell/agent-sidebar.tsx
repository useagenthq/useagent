import {
  RiAddLine,
  RiBook2Line,
  RiBookMarkedLine,
  RiBrainLine,
  RiBroadcastLine,
  RiCalendarScheduleLine,
  RiDatabase2Line,
  RiFlashlightLine,
  RiLayoutGridLine,
  RiPlugLine,
  RiPulseLine,
  RiSettings3Line,
} from '@remixicon/react';

import { Sidebar, SidebarNavItem } from './sidebar-nav';
import { SidebarRecents } from './sidebar-recents';

export interface AgentSidebarProps {
  /** Key of the active primary nav item (e.g. "active-runs"). */
  active?: string;
}

export function AgentSidebar({ active }: AgentSidebarProps) {
  return (
    <Sidebar ariaLabel='Agent navigation'>
      <SidebarNavItem
        href='/agent/new'
        icon={RiAddLine}
        label='New task'
        active={active === 'new-task'}
      />
      <SidebarNavItem
        href='/agent/workspace'
        icon={RiLayoutGridLine}
        label='Workspace'
        active={active === 'workspace'}
      />
      <SidebarNavItem
        href='/agent/runs'
        icon={RiPulseLine}
        label='Active runs'
        active={active === 'active-runs'}
      />
      <SidebarNavItem
        href='/agent/artifacts'
        icon={RiBroadcastLine}
        label='Live Artifacts'
        active={active === 'live-artifacts'}
      />
      <SidebarNavItem
        href='/agent/automations'
        icon={RiCalendarScheduleLine}
        label='Automations'
        active={active === 'automations'}
      />
      <SidebarNavItem
        href='/agent/plugins'
        icon={RiPlugLine}
        label='Plugins'
        active={active === 'plugins'}
      />
      <SidebarNavItem
        href='/knowledge'
        icon={RiBrainLine}
        label='Knowledge'
        active={active === 'knowledge'}
      />
      <SidebarNavItem
        href='/memory'
        icon={RiDatabase2Line}
        label='Memory'
        active={active === 'memory'}
      />
      <SidebarNavItem
        href='/wiki'
        icon={RiBook2Line}
        label='Wiki'
        active={active === 'wiki'}
      />
      <SidebarNavItem
        href='/skills'
        icon={RiFlashlightLine}
        label='Skills'
        active={active === 'skills'}
      />
      <SidebarNavItem
        href='/playbooks'
        icon={RiBookMarkedLine}
        label='Playbooks'
        active={active === 'playbooks'}
      />
      {/* Secrets is NOT a top-level nav item - it lives under Settings > Secrets
          (one home, no duplicate sidebar entry, per user). /secrets still
          resolves for deep links. */}
      <SidebarNavItem
        href='/settings'
        icon={RiSettings3Line}
        label='Settings'
        active={active === 'settings'}
      />

      <SidebarRecents />
    </Sidebar>
  );
}
