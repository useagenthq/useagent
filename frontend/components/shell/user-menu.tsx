'use client';

import {
  RiApps2Line,
  RiLoginBoxLine,
  RiLogoutBoxRLine,
  RiSettings3Line,
} from '@remixicon/react';
import { useRouter } from 'next/navigation';
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
import { signOut, useSession } from '@/lib/auth';

/**
 * Account affordance in the sidebar clusters: an avatar that opens a BoardUI
 * base dropdown — identity header, Settings / Apps, sign-in/out. Identity is
 * the live better-auth session (lib/auth.ts); when there is none (the open
 * dev-org path) it invites sign-in. Theme switching lives in the shell
 * ThemeMenu, not here.
 */
export function UserMenu() {
  const router = useRouter();
  const { session, refresh } = useSession();
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

        <DropdownDivider />

        <DropdownItem onSelect={() => go('/settings')} className='px-2 py-1.5'>
          <RiSettings3Line className='size-5 shrink-0 text-foreground-icon-secondary' aria-hidden />
          <span className='text-body-2-medium'>Settings</span>
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
      </DropdownPopover>
    </Dropdown>
  );
}
