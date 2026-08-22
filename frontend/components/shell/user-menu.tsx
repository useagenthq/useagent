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

import { type ChipTone, IconChip } from '@/components/board-ui/icon-chip';
import { useThemeToggle } from '@/components/motion-ui/theme-toggle';
import * as Avatar from '@/components/ui/avatar';
import * as Badge from '@/components/ui/badge';
import * as Dropdown from '@/components/ui/dropdown';
import * as Switch from '@/components/ui/switch';
import { signOut, useSession } from '@/lib/auth';
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
      <span className='min-w-0 flex-1 truncate text-paragraph-sm text-text-strong-950'>
        {name}
      </span>
      <UsageMeter value={value} tone={tone} />
    </div>
  );
}

/**
 * Account affordance in the top-nav right cluster: an avatar that opens a
 * dropdown — identity header, Settings / Docs / Apps, sign-in/out, and a Models
 * section with segmented usage meters. Identity is the live better-auth session
 * (lib/auth.ts); when there is none (the open dev-org path) it invites sign-in.
 */
export function UserMenu() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const { isDark, toggle } = useThemeToggle();

  const signedIn = session !== null;
  const name = session?.user.name?.trim() || (signedIn ? session!.user.email : 'Guest');
  const email = session?.user.email ?? 'Not signed in';
  const image = session?.user.image ?? null;
  const initial = (name.charAt(0) || '?').toUpperCase();

  async function handleSignOut() {
    await signOut();
    refresh();
    router.push('/login');
    router.refresh();
  }

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type='button'
          aria-label='Open account menu'
          className='rounded-full outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2'
        >
          <Avatar.Root size='32' color='purple'>
            {image ? <Avatar.Image src={image} alt={name} /> : initial}
          </Avatar.Root>
        </button>
      </Dropdown.Trigger>

      <Dropdown.Content align='end' className='w-72'>
        <div className='flex items-center gap-3 px-2 py-1.5'>
          <Avatar.Root size='40' color='purple'>
            {image ? <Avatar.Image src={image} alt={name} /> : initial}
          </Avatar.Root>
          <div className='min-w-0'>
            <p className='truncate text-label-sm text-text-strong-950'>{name}</p>
            <p className='truncate text-paragraph-xs text-text-sub-600'>
              {email}
            </p>
          </div>
        </div>

        {/* Dark mode: an AlignUI Switch (matching the AlignUI dropdown reference)
            that drives the beUI-derived View Transition theme reveal via
            useThemeToggle. A plain row, not a Dropdown.Item, so the menu stays
            open while you flip modes. Aura/Harbor palettes live in the shell
            ThemeMenu. */}
        <div className='flex items-center gap-2 rounded-lg px-2 py-1.5'>
          <RiMoonLine className='size-[18px] shrink-0 text-text-sub-600' aria-hidden />
          <span className='flex-1 text-label-sm text-text-strong-950'>Dark mode</span>
          <Switch.Root
            checked={isDark}
            onCheckedChange={() => toggle()}
            aria-label='Toggle dark mode'
          />
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
        {signedIn ? (
          <Dropdown.Item onSelect={() => void handleSignOut()}>
            <Dropdown.ItemIcon as={RiLogoutBoxRLine} />
            Log out
          </Dropdown.Item>
        ) : (
          <Dropdown.Item onSelect={() => router.push('/login')}>
            <Dropdown.ItemIcon as={RiLoginBoxLine} />
            Sign in
          </Dropdown.Item>
        )}

        <Dropdown.Separator className='-mx-2 my-1 h-px bg-stroke-soft-200' />

        <p className='text-mono-label px-2 pb-1 pt-0.5 text-text-soft-400'>
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
      </Dropdown.Content>
    </Dropdown.Root>
  );
}
