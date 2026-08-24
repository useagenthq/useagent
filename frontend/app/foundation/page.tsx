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
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Chip } from '@/components/base/badges/chip';
import { Switch } from '@/components/base/switch/switch';
import { Tabs, TabList, Tab, TabPanel } from '@/components/base/tabs/tabs';

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === 'dark';

  return (
    <Button
      variant='secondary'
      size='small'
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label='Toggle theme'
      leadingIcon={mounted && isDark ? RiSunLine : RiMoonLine}
    >
      {mounted ? (isDark ? 'Light' : 'Dark') : 'Theme'}
    </Button>
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
    <section className='flex flex-col gap-4 border-t border-border-button-default py-8'>
      <p className='text-mono-label text-text-tertiary'>{label}</p>
      {children}
    </section>
  );
}

export default function Home() {
  return (
    <main className='min-h-dvh bg-background-primary-default'>
      {/* Halftone brand header */}
      <header className='relative overflow-hidden border-b border-border-button-default'>
        <div className='bg-halftone pointer-events-none absolute inset-0' aria-hidden />
        <div className='relative mx-auto flex max-w-4xl items-center justify-between px-6 py-10'>
          <div className='flex items-center gap-3'>
            <AsteriskMark className='size-8 text-text-primary' />
            <div className='flex flex-col'>
              <span className='text-title-3-medium text-text-primary'>useAgent</span>
              <span className='text-mono-label text-text-tertiary'>
                multi-harness agent platform
              </span>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className='mx-auto max-w-4xl px-6'>
        <div className='animate-ai-fade-up flex flex-col gap-1 py-10'>
          <h1 className='text-title-1-medium text-text-primary'>
            Component foundation
          </h1>
          <p className='text-body-regular text-text-secondary'>
            Base components on Tailwind v4, wired to the useAgent brand layer.
            This page proves the foundation renders in both themes.
          </p>
        </div>

        {/* Buttons */}
        <Section label='Button - variants & modes'>
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='primary' leadingIcon={RiSparkling2Line}>
              Primary
            </Button>
            <Button variant='secondary'>
              Neutral
            </Button>
            <Button variant='danger'>
              Error
            </Button>
            <Button variant='ghost'>
              Ghost
            </Button>
            <Button variant='primary' size='xs' leadingIcon={RiAddLine}>
              New run
            </Button>
          </div>
        </Section>

        {/* Input */}
        <Section label='Input - with leading icon'>
          <div className='max-w-sm'>
            <Input
              aria-label='Search'
              leadingIcon={RiSearch2Line}
              placeholder='Search agents, runs, skills…'
            />
          </div>
        </Section>

        {/* Badges */}
        <Section label='Badge - colors & variants'>
          <div className='flex flex-wrap items-center gap-2'>
            <Chip color='lime'>Running</Chip>
            <Chip color='blue'>Queued</Chip>
            <Chip color='yellow'>Review</Chip>
            <Chip color='rose'>Failed</Chip>
            <Chip color='purple'>
              <span className='size-1.5 rounded-full bg-current opacity-70' aria-hidden />
              Model
            </Chip>
          </div>
        </Section>

        {/* Switch */}
        <Section label='Switch'>
          <div className='flex items-center gap-3'>
            <Switch defaultSelected>Autopilot mode</Switch>
          </div>
        </Section>

        {/* Tabs */}
        <Section label='TabMenuHorizontal'>
          <Tabs defaultSelectedKey='overview'>
            <TabList aria-label='Foundation tabs'>
              <Tab id='overview' icon={RiFlashlightLine}>
                Overview
              </Tab>
              <Tab id='runs'>Runs</Tab>
              <Tab id='skills'>Skills</Tab>
            </TabList>
            <TabPanel id='overview' className='pt-4'>
              <p className='text-body-2-regular text-text-secondary'>
                Overview panel - the active-tab indicator animates underneath.
              </p>
            </TabPanel>
            <TabPanel id='runs' className='pt-4'>
              <p className='text-body-2-regular text-text-secondary'>Runs panel.</p>
            </TabPanel>
            <TabPanel id='skills' className='pt-4'>
              <p className='text-body-2-regular text-text-secondary'>Skills panel.</p>
            </TabPanel>
          </Tabs>
        </Section>

        {/* Motion primitives */}
        <Section label='Brand motion primitives'>
          <div className='flex flex-col gap-4'>
            <p className='agent-progress-loading-text text-body-medium'>
              Thinking through the plan…
            </p>
            <p className='text-body-2-medium text-text-primary'>
              Streaming output
              <span className='ai-caret ml-0.5 inline-block w-px bg-current align-middle' style={{ height: '1em' }} />
            </p>
            <div className='flex items-center gap-1.5'>
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className='ai-loading-pixel size-1.5 rounded-full bg-accent-500'
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
