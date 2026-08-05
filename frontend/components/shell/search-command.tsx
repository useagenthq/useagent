'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  RiAddLine,
  RiApps2Line,
  RiAppsLine,
  RiBook2Line,
  RiBrainLine,
  RiBroadcastLine,
  RiCalendarScheduleLine,
  RiChat3Line,
  RiCodeSSlashLine,
  RiCornerDownLeftLine,
  RiDashboardLine,
  RiFlashlightLine,
  RiFlaskLine,
  RiGitPullRequestLine,
  RiLayoutGridLine,
  RiPenNibLine,
  RiPlugLine,
  RiPulseLine,
  RiSearch2Line,
  RiSettings3Line,
} from '@remixicon/react';
import type { ComponentType } from 'react';

import * as CommandMenu from '@/components/ui/command-menu';
import * as Kbd from '@/components/ui/kbd';

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

type Cmd = {
  href: string;
  label: string;
  icon: IconComponent;
  group: 'Agent' | 'Chat' | 'Workspace';
};

// Every skynet-a route surfaced by the ⌘K palette. `/code` and `/design` are
// still being built and 404 until they land — listed regardless per the shell
// contract so the palette is the canonical route index.
const COMMANDS: Cmd[] = [
  { href: '/agent/runs', label: 'Active runs', icon: RiPulseLine, group: 'Agent' },
  { href: '/agent/workspace', label: 'Workspace', icon: RiLayoutGridLine, group: 'Agent' },
  { href: '/agent/artifacts', label: 'Live Artifacts', icon: RiBroadcastLine, group: 'Agent' },
  { href: '/agent/schedules', label: 'Schedules', icon: RiCalendarScheduleLine, group: 'Agent' },
  { href: '/agent/plugins', label: 'Plugins', icon: RiPlugLine, group: 'Agent' },
  { href: '/agent/new', label: 'New task', icon: RiAddLine, group: 'Agent' },

  { href: '/agent/new', label: 'New chat', icon: RiChat3Line, group: 'Chat' },
  { href: '/apps', label: 'Apps', icon: RiAppsLine, group: 'Chat' },
  { href: '/artifacts', label: 'Artifacts', icon: RiApps2Line, group: 'Chat' },

  { href: '/knowledge', label: 'Knowledge', icon: RiBrainLine, group: 'Workspace' },
  { href: '/wiki', label: 'Wiki', icon: RiBook2Line, group: 'Workspace' },
  { href: '/skills', label: 'Skills', icon: RiFlashlightLine, group: 'Workspace' },
  { href: '/settings', label: 'Settings', icon: RiSettings3Line, group: 'Workspace' },
  { href: '/dashboard', label: 'Dashboard', icon: RiDashboardLine, group: 'Workspace' },
  { href: '/review', label: 'Review', icon: RiGitPullRequestLine, group: 'Workspace' },
  { href: '/lab', label: 'Component lab', icon: RiFlaskLine, group: 'Workspace' },
  { href: '/code', label: 'Code', icon: RiCodeSSlashLine, group: 'Workspace' },
  { href: '/design', label: 'Design', icon: RiPenNibLine, group: 'Workspace' },
];

const GROUP_ORDER: Cmd['group'][] = ['Agent', 'Chat', 'Workspace'];

/**
 * The top-nav search pill + the ⌘K command palette it opens. Client-side so it
 * can own the open state, the global ⌘K / Ctrl+K shortcut, and router
 * navigation. Built on the vendored AlignUI CommandMenu (cmdk + Modal), which
 * supplies the portal, backdrop, focus trap, and Esc-to-close for free.
 */
export function SearchCommand() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  // Global ⌘K / Ctrl+K toggles the palette from anywhere.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSearch('');
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
        type='button'
        onClick={() => setOpen(true)}
        className='hidden h-9 w-[min(360px,42vw)] items-center gap-2 rounded-full border border-stroke-soft-200 bg-bg-white-0 px-3.5 text-text-soft-400 shadow-regular-xs outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 md:inline-flex'
      >
        <RiSearch2Line className='size-3.5 shrink-0' aria-hidden />
        <span className='flex-1 text-left text-paragraph-sm'>Search</span>
        <Kbd.Root>⌘K</Kbd.Root>
      </button>

      <CommandMenu.Dialog
        open={open}
        onOpenChange={handleOpenChange}
        overlayClassName='backdrop-blur-[3px]'
        className='max-h-[70vh] w-[min(92vw,40rem)]'
      >
        <div className='group/cmd-input flex items-center gap-2.5 px-5'>
          <RiSearch2Line
            className='size-5 shrink-0 text-text-soft-400'
            aria-hidden
          />
          <CommandMenu.Input
            className='h-14'
            placeholder='Type a command'
            value={search}
            onValueChange={setSearch}
          />
        </div>

        <CommandMenu.List>
          <Command.Empty className='px-5 py-8 text-center text-paragraph-sm text-text-soft-400'>
            No commands found
          </Command.Empty>
          {GROUP_ORDER.map((group) => (
            <CommandMenu.Group key={group} heading={group}>
              {COMMANDS.filter((c) => c.group === group).map((cmd) => (
                <CommandMenu.Item
                  key={cmd.href}
                  value={cmd.label}
                  onSelect={() => go(cmd.href)}
                >
                  <CommandMenu.ItemIcon as={cmd.icon} aria-hidden />
                  <span className='min-w-0 flex-1 truncate'>{cmd.label}</span>
                </CommandMenu.Item>
              ))}
            </CommandMenu.Group>
          ))}
        </CommandMenu.List>

        <CommandMenu.Footer>
          <span className='text-paragraph-xs text-text-sub-600'>
            {matchCount} {matchCount === 1 ? 'command' : 'commands'}
          </span>
          <div className='flex items-center gap-1.5 text-paragraph-xs text-text-soft-400'>
            <Kbd.Root>
              <RiCornerDownLeftLine className='size-3' aria-hidden />
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
