'use client';

import {
  RiApps2Line,
  RiAsterisk,
  RiFileTextLine,
  RiLoginBoxLine,
  RiLogoutBoxRLine,
  RiMoonLine,
  RiOpenaiFill,
  RiSettings3Line,
} from '@remixicon/react';
import { useRouter } from 'next/navigation';
import type { ComponentType } from 'react';
import { useState } from 'react';

import { Badge } from '@/components/base/badges/badge';
import {
  Dropdown,
  DropdownDivider,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from '@/components/base/dropdown/dropdown';
import { Avatar } from '@/components/base/avatar/avatar';
import { Switch } from '@/components/base/switch/switch';
import { type ChipTone, IconChip } from '@/components/board-ui/icon-chip';
import { useThemeToggle } from '@/components/motion-ui/theme-toggle';
import { signOut, useSession } from '@/lib/auth';
import { cx } from '@/utils/cx';

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
          className={cx(
            'h-3 w-[3px] rounded-full',
            index < filled
              ? tone === 'opus'
                ? 'bg-yellow-500'
                : 'bg-text-primary'
              : 'bg-background-tertiary-default',
          )}
        />
      ))}
    </span>
  );
}

function ModelRow({
  icon: Icon,
  chipTone,
  name,
  value,
  tone,
}: {
  icon: IconComponent;
  chipTone: ChipTone;
  name: string;
  value: number;
  tone: 'opus' | 'gpt';
}) {
  return (
    <div className='flex items-center gap-2 px-2 py-1.5'>
      <IconChip icon={Icon} tone={chipTone} size='sm' />
      <span className='min-w-0 flex-1 truncate text-body-2-regular text-text-primary'>
        {name}
      </span>
      <UsageMeter value={value} tone={tone} />
    </div>
  );
}

/**
 * Account affordance in the sidebar clusters: an avatar that opens a BoardUI
 * base dropdown — identity header, Settings / Docs / Apps, sign-in/out, and a
 * Models section with segmented usage meters. Identity is the live better-auth
 * session (lib/auth.ts); when there is none (the open dev-org path) it invites
 * sign-in.
 */
export function UserMenu() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const { isDark, toggle } = useThemeToggle();
  const [open, setOpen] = useState(false);

  const signedIn = session !== null;
  const name = session?.user.name?.trim() || (signedIn ? session!.user.email : 'Guest');
  const email = session?.user.email ?? 'Not signed in';
  const image = session?.user.image ?? null;
  const initial = (name.charAt(0) || '?').toUpperCase();

  async function handleSignOut() {
    setOpen(false);
    await signOut();
    refresh();
    router.push('/login');
    router.refresh();
  }

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <DropdownTrigger
        aria-label='Open account menu'
        className='rounded-full focus-visible:ring-offset-2'
      >
        <Avatar
          size='md'
          color='pink'
          src={image ?? undefined}
          alt={name}
          initials={initial}
        />
      </DropdownTrigger>

      <DropdownPopover aria-label='Account menu' placement='bottom end' className='w-72'>
        <div className='flex items-center gap-3 px-2 py-1.5'>
          <Avatar
            size='lg'
            color='pink'
            src={image ?? undefined}
            alt={name}
            initials={initial}
          />
          <div className='min-w-0'>
            <p className='truncate text-body-2-medium text-text-primary'>{name}</p>
            <p className='truncate text-caption-1-regular text-text-secondary'>
              {email}
            </p>
          </div>
        </div>

        {/* Dark mode: a BoardUI base Switch that drives the beUI-derived View
            Transition theme reveal via useThemeToggle. A plain row, not a
            DropdownItem, so the menu stays open while you flip modes.
            Aura/Harbor palettes live in the shell ThemeMenu. */}
        <div className='flex items-center gap-2 rounded-2lg px-2 py-1.5'>
          <RiMoonLine className='size-[18px] shrink-0 text-foreground-icon-secondary' aria-hidden />
          <span className='flex-1 text-body-2-medium text-text-primary'>Dark mode</span>
          <Switch
            size='sm'
            isSelected={isDark}
            onChange={() => toggle()}
            aria-label='Toggle dark mode'
          />
        </div>

        <DropdownDivider />

        <DropdownItem onSelect={() => go('/settings')} className='px-2 py-1.5'>
          <RiSettings3Line className='size-5 shrink-0 text-foreground-icon-secondary' aria-hidden />
          <span className='text-body-2-medium'>Settings</span>
        </DropdownItem>
        <DropdownItem
          onSelect={() => {
            setOpen(false);
            window.open('http://localhost:3300', '_blank', 'noopener');
          }}
          className='px-2 py-1.5'
        >
          <RiFileTextLine className='size-5 shrink-0 text-foreground-icon-secondary' aria-hidden />
          <span className='text-body-2-medium'>Docs</span>
        </DropdownItem>
        <DropdownItem onSelect={() => go('/apps')} className='px-2 py-1.5'>
          <RiApps2Line className='size-5 shrink-0 text-foreground-icon-secondary' aria-hidden />
          <span className='min-w-0 flex-1 truncate text-body-2-medium'>Apps</span>
          <Badge className='bg-badge-new-background text-badge-new-text'>New</Badge>
        </DropdownItem>
        {signedIn ? (
          <DropdownItem onSelect={() => void handleSignOut()} className='px-2 py-1.5'>
            <RiLogoutBoxRLine className='size-5 shrink-0 text-foreground-icon-secondary' aria-hidden />
            <span className='text-body-2-medium'>Log out</span>
          </DropdownItem>
        ) : (
          <DropdownItem onSelect={() => go('/login')} className='px-2 py-1.5'>
            <RiLoginBoxLine className='size-5 shrink-0 text-foreground-icon-secondary' aria-hidden />
            <span className='text-body-2-medium'>Sign in</span>
          </DropdownItem>
        )}

        <DropdownDivider />

        <p className='text-mono-label px-2 pb-1 pt-0.5 text-text-tertiary'>
          Models
        </p>
        <ModelRow
          icon={RiAsterisk}
          chipTone='orange'
          name='Opus 4.7'
          value={0.8}
          tone='opus'
        />
        <ModelRow
          icon={RiOpenaiFill}
          chipTone='green'
          name='GPT 5.5'
          value={0.95}
          tone='gpt'
        />
      </DropdownPopover>
    </Dropdown>
  );
}
