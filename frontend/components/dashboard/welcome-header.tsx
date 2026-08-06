import Link from 'next/link';
import { RiAddLine } from '@remixicon/react';

import * as Avatar from '@/components/ui/avatar';
import * as AvatarGroup from '@/components/ui/avatar-group';
import * as Button from '@/components/ui/button';

/** The people whose fleet this dashboard rolls up — initials-only, no assets. */
const TEAM = [
  { initials: 'AG', color: 'blue' },
  { initials: 'MK', color: 'purple' },
  { initials: 'SR', color: 'sky' },
  { initials: 'JD', color: 'yellow' },
] as const;

export function WelcomeHeader({ liveCount = 0 }: { liveCount?: number }) {
  return (
    <header className='flex flex-wrap items-start justify-between gap-4'>
      <div className='flex flex-col gap-1'>
        <p className='text-mono-label text-text-soft-400'>Overview</p>
        <h1 className='text-display-md text-text-strong-950'>Welcome back</h1>
        <p className='text-paragraph-sm text-text-sub-600'>
          {liveCount > 0
            ? `${liveCount} ${liveCount === 1 ? 'agent is' : 'agents are'} working right now - here's the fleet at a glance.`
            : "Here's what your agent fleet has been up to."}
        </p>
      </div>

      <div className='flex items-center gap-4'>
        <div className='hidden items-center gap-3 sm:flex'>
          <AvatarGroup.Root size='32'>
            {TEAM.map((member) => (
              <Avatar.Root key={member.initials} color={member.color}>
                {member.initials}
              </Avatar.Root>
            ))}
            <AvatarGroup.Overflow>+3</AvatarGroup.Overflow>
          </AvatarGroup.Root>
          <span className='text-paragraph-xs text-text-soft-400'>Board team</span>
        </div>

        <Button.Root className="rounded-full" asChild variant='primary' mode='filled' size='small'>
          <Link href='/agent/new'>
            <Button.Icon as={RiAddLine} />
            New run
          </Link>
        </Button.Root>
      </div>
    </header>
  );
}
