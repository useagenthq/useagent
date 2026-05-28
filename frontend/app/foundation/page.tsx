'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import {
  RiMoonLine,
  RiSunLine,
  RiSearch2Line,
  RiSparkling2Line,
  RiAddLine,
  RiFlashlightLine,
} from '@remixicon/react';

import { AsteriskMark } from '@/components/foundations/brand/asterisk-mark';
import * as Button from '@/components/ui/button';
import * as Input from '@/components/ui/input';
import * as Badge from '@/components/ui/badge';
import * as Switch from '@/components/ui/switch';
import * as TabMenuHorizontal from '@/components/ui/tab-menu-horizontal';

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === 'dark';

  return (
    <Button.Root
      variant='neutral'
      mode='stroke'
      size='small'
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label='Toggle theme'
    >
      <Button.Icon as={mounted && isDark ? RiSunLine : RiMoonLine} />
      {mounted ? (isDark ? 'Light' : 'Dark') : 'Theme'}
    </Button.Root>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className='flex flex-col gap-4 border-t border-stroke-soft-200 py-8'>
      <p className='text-mono-label text-text-soft-400'>{label}</p>
      {children}
    </section>
  );
}

export default function Home() {
  return (
    <main className='min-h-dvh bg-bg-white-0'>
      {/* Halftone brand header */}
      <header className='relative overflow-hidden border-b border-stroke-soft-200'>
        <div className='bg-halftone pointer-events-none absolute inset-0' aria-hidden />
        <div className='relative mx-auto flex max-w-4xl items-center justify-between px-6 py-10'>
          <div className='flex items-center gap-3'>
            <AsteriskMark className='size-8 text-text-strong-950' />
            <div className='flex flex-col'>
              <span className='text-label-lg text-text-strong-950'>useAgent</span>
              <span className='text-mono-label text-text-soft-400'>
                multi-harness agent platform
              </span>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className='mx-auto max-w-4xl px-6'>
        <div className='animate-ai-fade-up flex flex-col gap-1 py-10'>
          <h1 className='text-title-h4 text-text-strong-950'>
            AlignUI foundation
          </h1>
          <p className='text-paragraph-md text-text-sub-600'>
            Vendored AlignUI base components on Tailwind v4, wired to the useAgent
            brand layer. This page proves the foundation renders in both themes.
          </p>
        </div>

        {/* Buttons */}
        <Section label='Button - variants & modes'>
          <div className='flex flex-wrap items-center gap-3'>
            <Button.Root variant='primary' mode='filled'>
              <Button.Icon as={RiSparkling2Line} />
              Primary
            </Button.Root>
            <Button.Root variant='neutral' mode='stroke'>
              Neutral
            </Button.Root>
            <Button.Root variant='error' mode='lighter'>
              Error
            </Button.Root>
            <Button.Root variant='primary' mode='ghost'>
              Ghost
            </Button.Root>
            <Button.Root variant='primary' mode='filled' size='xsmall'>
              <Button.Icon as={RiAddLine} />
              New run
            </Button.Root>
          </div>
        </Section>

        {/* Input */}
        <Section label='Input - with leading icon'>
          <div className='max-w-sm'>
            <Input.Root>
              <Input.Wrapper>
                <Input.Icon as={RiSearch2Line} />
                <Input.Input placeholder='Search agents, runs, skills…' />
              </Input.Wrapper>
            </Input.Root>
          </div>
        </Section>

        {/* Badges */}
        <Section label='Badge - colors & variants'>
          <div className='flex flex-wrap items-center gap-2'>
            <Badge.Root variant='filled' color='green'>
              Running
            </Badge.Root>
            <Badge.Root variant='light' color='blue'>
              Queued
            </Badge.Root>
            <Badge.Root variant='lighter' color='orange'>
              Review
            </Badge.Root>
            <Badge.Root variant='stroke' color='red'>
              Failed
            </Badge.Root>
            <Badge.Root variant='light' color='purple'>
              <Badge.Dot />
              Model
            </Badge.Root>
          </div>
        </Section>

        {/* Switch */}
        <Section label='Switch'>
          <div className='flex items-center gap-3'>
            <Switch.Root defaultChecked id='autopilot' />
            <label htmlFor='autopilot' className='text-label-sm text-text-strong-950'>
              Autopilot mode
            </label>
          </div>
        </Section>

        {/* Tabs */}
        <Section label='TabMenuHorizontal'>
          <TabMenuHorizontal.Root defaultValue='overview'>
            <TabMenuHorizontal.List>
              <TabMenuHorizontal.Trigger value='overview'>
                <TabMenuHorizontal.Icon as={RiFlashlightLine} />
                Overview
              </TabMenuHorizontal.Trigger>
              <TabMenuHorizontal.Trigger value='runs'>
                Runs
              </TabMenuHorizontal.Trigger>
              <TabMenuHorizontal.Trigger value='skills'>
                Skills
              </TabMenuHorizontal.Trigger>
            </TabMenuHorizontal.List>
            <TabMenuHorizontal.Content value='overview' className='pt-4'>
              <p className='text-paragraph-sm text-text-sub-600'>
                Overview panel - the active-tab indicator animates underneath.
              </p>
            </TabMenuHorizontal.Content>
            <TabMenuHorizontal.Content value='runs' className='pt-4'>
              <p className='text-paragraph-sm text-text-sub-600'>Runs panel.</p>
            </TabMenuHorizontal.Content>
            <TabMenuHorizontal.Content value='skills' className='pt-4'>
              <p className='text-paragraph-sm text-text-sub-600'>Skills panel.</p>
            </TabMenuHorizontal.Content>
          </TabMenuHorizontal.Root>
        </Section>

        {/* Motion primitives */}
        <Section label='Brand motion primitives'>
          <div className='flex flex-col gap-4'>
            <p className='agent-progress-loading-text text-label-md'>
              Thinking through the plan…
            </p>
            <p className='text-label-sm text-text-strong-950'>
              Streaming output
              <span className='ai-caret ml-0.5 inline-block w-px bg-current align-middle' style={{ height: '1em' }} />
            </p>
            <div className='flex items-center gap-1.5'>
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className='ai-loading-pixel size-1.5 rounded-full bg-primary-base'
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
          </div>
        </Section>

        <div className='h-16' />
      </div>
    </main>
  );
}
