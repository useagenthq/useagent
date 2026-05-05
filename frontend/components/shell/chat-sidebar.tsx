import {
  RiAddLine,
  RiApps2Line,
  RiAppsLine,
  RiBook2Line,
  RiBrainLine,
  RiFigmaLine,
  RiFlashlightLine,
  RiFolderLine,
  RiGithubFill,
  RiGoogleFill,
  RiHandHeartLine,
  RiNotionFill,
  RiSlackFill,
  RiStackLine,
} from '@remixicon/react';
import type { ComponentType } from 'react';

import * as Badge from '@/components/ui/badge';
import { Sidebar, SidebarNavItem, SidebarSectionLabel } from './sidebar-nav';

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

export interface ChatSidebarProps {
  /** Key of the active primary nav item (e.g. "welcome"). */
  active?: string;
}

const projects = [
  'Growth Campaign',
  'Content Engine',
  'Automation Flow',
  'User Research',
];

const recents = [
  'Fix spacing on cards',
  'Need better empty state',
  'Update sidebar structure',
  'Mobile nav feels cramped',
  'Can we simplify this?',
  'Generate onboarding copy',
  'Improve search results',
  'Settings page feedback',
];

const connectApps: IconComponent[] = [
  RiFigmaLine,
  RiGithubFill,
  RiGoogleFill,
  RiSlackFill,
  RiNotionFill,
];

function ConnectAppsFooter() {
  return (
    <div className='border-t border-stroke-soft-200 px-4 py-3.5'>
      <p className='text-label-sm text-text-strong-950'>Connect apps</p>
      <p className='mt-0.5 text-paragraph-xs text-text-sub-600'>
        External apps such as Figma, Github, Drive
      </p>
      <div className='mt-2.5 flex items-center gap-1.5'>
        {connectApps.map((Icon, index) => (
          <span
            key={index}
            className='flex size-6 items-center justify-center rounded-md border border-stroke-soft-200 bg-bg-weak-50'
          >
            <Icon className='size-3.5 text-text-sub-600' aria-hidden />
          </span>
        ))}
      </div>
    </div>
  );
}

export function ChatSidebar({ active = 'welcome' }: ChatSidebarProps) {
  return (
    <Sidebar ariaLabel='Chat navigation' footer={<ConnectAppsFooter />}>
      <SidebarNavItem
        href='/welcome'
        icon={RiHandHeartLine}
        label='Welcome'
        active={active === 'welcome'}
      />
      <SidebarNavItem
        href='/agent/new'
        icon={RiAddLine}
        label='New chat'
        active={active === 'new-chat'}
      />
      <SidebarNavItem
        href='/agent/workspace'
        icon={RiStackLine}
        label='Projects'
        active={active === 'projects'}
      />
      <SidebarNavItem
        href='/artifacts'
        icon={RiApps2Line}
        label='Artifacts'
        active={active === 'artifacts'}
      />
      <SidebarNavItem
        href='/apps'
        icon={RiAppsLine}
        label='Apps'
        active={active === 'apps'}
        trailing={
          <Badge.Root variant='light' color='red' size='small'>
            New
          </Badge.Root>
        }
      />
      <SidebarNavItem
        href='/knowledge'
        icon={RiBrainLine}
        label='Knowledge'
        active={active === 'knowledge'}
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

      <SidebarSectionLabel>Projects</SidebarSectionLabel>
      {projects.map((name) => (
        <SidebarNavItem
          key={name}
          href='/agent/workspace'
          icon={RiFolderLine}
          label={name}
        />
      ))}

      <SidebarSectionLabel>Recents</SidebarSectionLabel>
      {recents.map((name) => (
        <SidebarNavItem key={name} href='/agent/runs' label={name} />
      ))}
    </Sidebar>
  );
}
