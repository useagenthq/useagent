import type { ReactNode } from 'react';
import { RiPenNibLine } from '@remixicon/react';

import * as Badge from '@/components/ui/badge';
import * as Button from '@/components/ui/button';

/**
 * Soft gradient artboards, built with layered `bg-linear-*` + `bg-radial-[at_..]`
 * mesh utilities. Purely decorative Tailwind palette colors, so they read
 * correctly in both light and dark app themes.
 */
type Tone = 'bloom' | 'sun' | 'mint';

const toneArt: Record<Tone, ReactNode> = {
  // pink / violet mesh
  bloom: (
    <>
      <div className='absolute inset-0 bg-linear-120 from-violet-200 via-white to-sky-200' />
      <div className='absolute inset-0 bg-radial-[at_22%_30%] from-fuchsia-300/70 from-0% to-transparent to-55%' />
      <div className='absolute inset-0 bg-radial-[at_46%_86%] from-pink-300/70 from-0% to-transparent to-50%' />
      <div className='absolute inset-0 bg-radial-[at_84%_40%] from-blue-300/60 from-0% to-transparent to-60%' />
    </>
  ),
  // blue field with a warm orange/amber sun glow
  sun: (
    <>
      <div className='absolute inset-0 bg-linear-to-b from-sky-300 to-blue-200' />
      <div className='absolute inset-0 bg-radial-[at_50%_78%] from-pink-300/80 from-0% to-transparent to-58%' />
      <div className='absolute inset-0 bg-radial-[at_50%_84%] from-orange-400/90 via-amber-300/70 to-transparent to-46%' />
    </>
  ),
  // mint / teal
  mint: (
    <>
      <div className='absolute inset-0 bg-linear-135 from-emerald-200 via-white to-teal-200' />
      <div className='absolute inset-0 bg-radial-[at_28%_32%] from-teal-300/70 from-0% to-transparent to-55%' />
      <div className='absolute inset-0 bg-radial-[at_78%_74%] from-emerald-300/70 from-0% to-transparent to-52%' />
      <div className='absolute inset-0 bg-radial-[at_60%_18%] from-cyan-200/70 from-0% to-transparent to-55%' />
    </>
  ),
};

/**
 * Small white mock elements floated on the artboard — each built from plain
 * divs so the "canvas" hints at what the frame contains without real chrome.
 */
type Mock = 'button' | 'card' | 'nav' | 'tiles';

function MockElement({ kind }: { kind: Mock }) {
  switch (kind) {
    case 'nav':
      return (
        <div className='flex h-9 w-48 items-center gap-2 rounded-full border border-stroke-soft-200 bg-bg-white-0 px-3 shadow-regular-sm'>
          <div className='size-2.5 shrink-0 rounded-full bg-bg-strong-950' />
          <div className='flex flex-1 items-center justify-center gap-1.5'>
            <div className='h-1.5 w-6 rounded-full bg-bg-soft-200' />
            <div className='h-1.5 w-6 rounded-full bg-bg-soft-200' />
            <div className='h-1.5 w-6 rounded-full bg-bg-soft-200' />
          </div>
          <div className='h-4 w-8 shrink-0 rounded-full bg-bg-strong-950' />
        </div>
      );
    case 'card':
      return (
        <div className='w-40 rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-3 shadow-regular-sm'>
          <div className='size-6 rounded-md bg-bg-soft-200' />
          <div className='mt-2.5 h-1.5 w-full rounded-full bg-bg-soft-200' />
          <div className='mt-1.5 h-1.5 w-2/3 rounded-full bg-bg-soft-200' />
          <div className='mt-3 h-5 w-16 rounded-full bg-bg-strong-950' />
        </div>
      );
    case 'tiles':
      return (
        <div className='grid w-40 grid-cols-3 gap-2'>
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className='flex aspect-square items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm'
            >
              <div className='size-1.5 rounded-full bg-bg-soft-200' />
            </div>
          ))}
        </div>
      );
    case 'button':
      return (
        <div className='flex w-40 flex-col items-center gap-2 rounded-xl border border-stroke-soft-200 bg-bg-white-0 px-4 py-4 shadow-regular-sm'>
          <div className='h-1.5 w-20 rounded-full bg-bg-soft-200' />
          <div className='h-1.5 w-14 rounded-full bg-bg-soft-200' />
          <div className='mt-1 h-7 w-24 rounded-full bg-bg-strong-950' />
        </div>
      );
  }
}

interface Frame {
  name: string;
  time: string;
  tone: Tone;
  mock: Mock;
  status: 'Draft' | 'Ready';
}

const frames: Frame[] = [
  { name: 'Landing hero', time: '2h', tone: 'bloom', mock: 'button', status: 'Ready' },
  { name: 'Pricing cards', time: '5h', tone: 'sun', mock: 'card', status: 'Draft' },
  { name: 'Mobile nav', time: '1d', tone: 'mint', mock: 'nav', status: 'Ready' },
  { name: 'Empty state', time: '3h', tone: 'bloom', mock: 'card', status: 'Draft' },
  { name: 'Onboarding flow', time: '6h', tone: 'sun', mock: 'button', status: 'Ready' },
  { name: 'Brand tiles', time: '2d', tone: 'mint', mock: 'tiles', status: 'Draft' },
];

function FrameCard({ name, time, tone, mock, status }: Frame) {
  return (
    <article className='flex flex-col overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm'>
      <div className='relative flex h-44 items-center justify-center overflow-hidden'>
        {toneArt[tone]}
        <div className='relative z-10'>
          <MockElement kind={mock} />
        </div>
      </div>
      <div className='flex flex-col gap-1 p-4'>
        <div className='flex items-center justify-between gap-2'>
          <h2 className='truncate text-label-sm text-text-strong-950'>{name}</h2>
          <Badge.Root
            variant={status === 'Ready' ? 'light' : 'lighter'}
            color={status === 'Ready' ? 'green' : 'gray'}
          >
            {status}
          </Badge.Root>
        </div>
        <p className='text-paragraph-xs text-text-sub-600'>Edited {time} ago</p>
      </div>
    </article>
  );
}

export function DesignGallery() {
  return (
    <div className='mx-auto w-full max-w-[1040px] px-6 py-8 sm:px-10 sm:py-10'>
      <div className='flex items-center justify-between gap-3'>
        <div className='flex items-center gap-2.5'>
          <RiPenNibLine aria-hidden className='size-5 text-text-strong-950' />
          <h1 className='text-display-md text-text-strong-950'>Design</h1>
        </div>
        <Button.Root className="rounded-full" variant='neutral' mode='filled' size='small'>
          New frame
        </Button.Root>
      </div>

      <div className='mt-8 grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3'>
        {frames.map((frame) => (
          <FrameCard key={frame.name} {...frame} />
        ))}
      </div>
    </div>
  );
}
