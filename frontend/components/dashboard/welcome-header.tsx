import { RiAddLine } from '@remixicon/react';

import { ButtonLink } from '@/components/base/buttons/button';

export function WelcomeHeader({ liveCount = 0 }: { liveCount?: number }) {
  return (
    <header className='flex flex-wrap items-start justify-between gap-4'>
      <div className='flex flex-col gap-1'>
        <p className='text-mono-label text-text-tertiary'>Overview</p>
        <h1 className='text-display-sm text-text-primary'>Welcome back</h1>
        <p className='text-body-2-regular text-text-secondary'>
          {liveCount > 0
            ? `${liveCount} ${liveCount === 1 ? 'agent is' : 'agents are'} working right now - here's the fleet at a glance.`
            : "Here's what your agent fleet has been up to."}
        </p>
      </div>

      <div className='flex items-center gap-4'>
        <ButtonLink
          href='/agent/new'
          variant='primary'
          size='small'
          leadingIcon={RiAddLine}
          className='rounded-full'
        >
          New run
        </ButtonLink>
      </div>
    </header>
  );
}
