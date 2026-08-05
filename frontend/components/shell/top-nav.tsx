'use client';

import type { ComponentType } from 'react';
import Link from 'next/link';
import { RiChat3Line, RiRobot2Line } from '@remixicon/react';

import { AsteriskMark } from '@/components/foundations/brand/asterisk-mark';
import { cnExt } from '@/utils/cn';
import { SearchCommand } from './search-command';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

// 'code' | 'design' are retained so the /code, /lab, /review and /design routes
// still typecheck when they pass `activeTab` — those tabs no longer render here,
// but the routes stay reachable via ⌘K (search-command).
export type TopNavTab = 'chat' | 'agent' | 'code' | 'design';

export interface TopNavProps {
  activeTab: TopNavTab;
}

const tabs: {
  id: TopNavTab;
  label: string;
  icon: IconComponent;
  href: string;
}[] = [
  { id: 'chat', label: 'Chat', icon: RiChat3Line, href: '/' },
  { id: 'agent', label: 'Agent', icon: RiRobot2Line, href: '/agent/runs' },
];

export function TopNav({ activeTab }: TopNavProps) {
  return (
    <header className='grid grid-cols-[1fr_auto] items-center gap-3 border-b border-stroke-soft-200 bg-bg-white-0 px-3 py-2.5 md:grid-cols-[1fr_auto_1fr]'>
      {/* Left: logo + tab pills */}
      <div className='flex min-w-0 items-center gap-1'>
        <Link
          href='/'
          aria-label='skynet-a home'
          className='flex size-9 shrink-0 items-center justify-center rounded-lg text-text-strong-950 transition-colors hover:bg-bg-weak-50'
        >
          <AsteriskMark className='size-5' />
        </Link>
        <div className='flex items-center gap-0.5'>
          {tabs.map(({ id, label, icon: Icon, href }) => {
            const active = id === activeTab;
            return (
              <Link
                key={id}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cnExt(
                  'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-label-sm transition-colors',
                  active
                    ? 'bg-bg-white-0 text-text-strong-950 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200'
                    : 'text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950',
                )}
              >
                <Icon
                  className={cnExt(
                    'size-3.5 shrink-0',
                    active ? 'text-text-strong-950' : 'text-text-soft-400',
                  )}
                  aria-hidden
                />
                <span className='hidden sm:inline'>{label}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Center: search pill + ⌘K command palette */}
      <div className='hidden justify-center md:flex'>
        <SearchCommand />
      </div>

      {/* Right: org chip, theme, account */}
      <div className='flex min-w-0 items-center justify-end gap-1'>
        <button
          type='button'
          className='hidden items-center gap-1.5 rounded-lg px-2 py-1.5 text-label-sm text-text-sub-600 transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 lg:inline-flex'
        >
          <span className='flex size-5 items-center justify-center rounded-full bg-feature-base text-[10px] font-medium text-static-white'>
            S
          </span>
          Skynet Dev
        </button>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
