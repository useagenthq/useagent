import {
  RiAddLine,
  RiBarChartBoxLine,
  RiBookMarkedLine,
  RiFolderLine,
  RiSettings3Line,
} from '@remixicon/react';

import { SearchCommand } from './search-command';
import { Sidebar, SidebarNavItem } from './sidebar-nav';
import { SidebarProjects } from './sidebar-projects';
import { SidebarRecents } from './sidebar-recents';

export type ThreadSidebarActive = 'new' | 'projects' | 'usage' | 'library' | 'settings';

function ThreadSidebarFooter({ active }: { active?: ThreadSidebarActive }) {
  return (
    <nav aria-label='Workspace utilities' className='border-t border-stroke-soft-200 p-3'>
      <SidebarNavItem
        href='/settings#usage'
        icon={RiBarChartBoxLine}
        label='Usage'
        active={active === 'usage'}
      />
      <SidebarNavItem
        href='/skills'
        icon={RiBookMarkedLine}
        label='Library'
        active={active === 'library'}
      />
      <SidebarNavItem
        href='/settings'
        icon={RiSettings3Line}
        label='Settings'
        active={active === 'settings'}
      />
    </nav>
  );
}

export function ThreadSidebar({ active }: { active?: ThreadSidebarActive }) {
  return (
    <Sidebar ariaLabel='Thread navigation' footer={<ThreadSidebarFooter active={active} />}>
      <SidebarNavItem
        href='/agent/new'
        icon={RiAddLine}
        label='New thread'
        active={active === 'new'}
      />
      <SearchCommand variant='sidebar' />
      <SidebarNavItem
        href='/agent/workspace'
        icon={RiFolderLine}
        label='All projects'
        active={active === 'projects'}
      />
      <SidebarProjects />
      <SidebarRecents />
    </Sidebar>
  );
}
