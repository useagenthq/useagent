'use client';

import {
  RiApps2Line,
  RiAsterisk,
  RiFileTextLine,
  RiLogoutBoxRLine,
  RiOpenaiFill,
  RiSettings3Line,
} from '@remixicon/react';
import { useRouter } from 'next/navigation';
import type { ComponentType } from 'react';

import * as Avatar from '@/components/ui/avatar';
import * as Badge from '@/components/ui/badge';
import * as Dropdown from '@/components/ui/dropdown';
import { cn } from '@/utils/cn';

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

const MODEL_METER_BARS = 16;

/** Tiny segmented usage meter built from divs (Figma "Models" section). */
function UsageMeter({ value, tone }: { value: number; tone: 'opus' | 'gpt' }) {
  const filled = Math.round(MODEL_METER_BARS * value);
  return (
    <span className='flex items-center gap-[3px]' aria-hidden>
      {Array.from({ length: MODEL_METER_BARS }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-3 w-[3px] rounded-full',
            index < filled
              ? tone === 'opus'
                ? 'bg-warning-base'
                : 'bg-text-strong-950'
              : 'bg-bg-soft-200',
          )}
        />
      ))}
    </span>
  );
}

function ModelRow({
  icon: Icon,
  iconClassName,
  name,
  value,
  tone,
}: {
  icon: IconComponent;
  iconClassName: string;
  name: string;
  value: number;
  tone: 'opus' | 'gpt';
}) {
  return (
    <div className='flex items-center gap-2 px-2 py-1.5'>
      <Icon className={cn('size-3.5 shrink-0', iconClassName)} aria-hidden />
      <span className='min-w-0 flex-1 truncate text-paragraph-sm text-text-strong-950'>
        {name}
      </span>
      <UsageMeter value={value} tone={tone} />
    </div>
  );
}

/**
 * Account affordance in the top-nav right cluster: an avatar that opens a
 * dropdown — identity header, Settings / Language / Docs / Apps / Logout, and a
 * Models section with segmented usage meters. Identity + usage are static for
 * now (skynet-a has no auth wired yet); pattern ported from skynet-saas.
 */
export function UserMenu() {
  const router = useRouter();

  const name = 'Dev User';
  const email = 'you@example.com';
  const initial = 'A';

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type='button'
          aria-label='Open account menu'
          className='rounded-full outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2'
        >
          <Avatar.Root size='32' color='purple'>
            {initial}
          </Avatar.Root>
        </button>
      </Dropdown.Trigger>

      <Dropdown.Content align='end' className='w-72'>
        <div className='flex items-center gap-3 px-2 py-1.5'>
          <Avatar.Root size='40' color='purple'>
            {initial}
          </Avatar.Root>
          <div className='min-w-0'>
            <p className='truncate text-label-sm text-text-strong-950'>{name}</p>
            <p className='truncate text-paragraph-xs text-text-sub-600'>
              {email}
            </p>
          </div>
        </div>

        <Dropdown.Separator className='-mx-2 my-1 h-px bg-stroke-soft-200' />

        <Dropdown.Item onSelect={() => router.push('/settings')}>
          <Dropdown.ItemIcon as={RiSettings3Line} />
          Settings
        </Dropdown.Item>
        <Dropdown.Item
          onSelect={() =>
            window.open('http://localhost:3300', '_blank', 'noopener')
          }
        >
          <Dropdown.ItemIcon as={RiFileTextLine} />
          Docs
        </Dropdown.Item>
        <Dropdown.Item onSelect={() => router.push('/apps')}>
          <Dropdown.ItemIcon as={RiApps2Line} />
          <span className='min-w-0 flex-1 truncate'>Apps</span>
          <Badge.Root variant='light' color='red' size='small'>
            New
          </Badge.Root>
        </Dropdown.Item>
        <Dropdown.Item onSelect={() => router.push('/login')}>
          <Dropdown.ItemIcon as={RiLogoutBoxRLine} />
          Logout
        </Dropdown.Item>

        <Dropdown.Separator className='-mx-2 my-1 h-px bg-stroke-soft-200' />

        <p className='text-mono-label px-2 pb-1 pt-0.5 text-text-soft-400'>
          Models
        </p>
        <ModelRow
          icon={RiAsterisk}
          iconClassName='text-warning-base'
          name='Opus 4.7'
          value={0.8}
          tone='opus'
        />
        <ModelRow
          icon={RiOpenaiFill}
          iconClassName='text-text-strong-950'
          name='GPT 5.5'
          value={0.95}
          tone='gpt'
        />
      </Dropdown.Content>
    </Dropdown.Root>
  );
}
