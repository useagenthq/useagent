import type { Metadata } from 'next';
import type { ComponentType } from 'react';
import {
  RiAppleFill,
  RiBroadcastLine,
  RiPlayCircleLine,
  RiSendPlaneLine,
} from '@remixicon/react';

import { AgentSidebar } from '@/components/shell/agent-sidebar';
import { AppShell } from '@/components/shell/app-shell';

export const metadata: Metadata = {
  title: 'Pair with Mobile app',
  description: 'Keep working with Skynet from your phone, or other device.',
};

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

const features: { icon: IconComponent; title: string; body: string }[] = [
  {
    icon: RiBroadcastLine,
    title: 'Resume instantly',
    body: 'Pick up any agent run or workspace from your desktop',
  },
  {
    icon: RiPlayCircleLine,
    title: 'Stay connected',
    body: 'Get notified when Skynet completes tasks or needs input',
  },
  {
    icon: RiSendPlaneLine,
    title: 'Start from anywhere',
    body: 'Launch new workflows directly from your phone',
  },
];

export default function AgentMobilePage() {
  return (
    <AppShell activeTab='agent' sidebar={<AgentSidebar active='mobile' />}>
      <div className='animate-ai-fade-up p-8 lg:p-12'>
        <section className='flex max-w-xl flex-col'>
          <RiAppleFill className='size-8 text-text-strong-950' aria-hidden />

          <h1 className='mt-6 text-display-sm text-text-strong-950'>
            Pair with Mobile app
          </h1>
          <p className='mt-2 text-paragraph-md text-text-sub-600'>
            Keep working with Skynet from your phone, or other device
          </p>

          <div className='mt-6'>
            <button
              type='button'
              className='inline-flex h-10 items-center justify-center rounded-full bg-bg-strong-950 px-5 text-label-sm text-text-white-0 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2'
            >
              Connect device
            </button>
          </div>

          <div className='mt-10 divide-y divide-stroke-soft-200 overflow-hidden rounded-2xl border border-stroke-soft-200'>
            {features.map(({ icon: Icon, title, body }) => (
              <div key={title} className='flex items-start gap-4 px-5 py-4'>
                <Icon
                  className='mt-0.5 size-5 shrink-0 text-text-sub-600'
                  aria-hidden
                />
                <div>
                  <p className='text-label-sm text-text-strong-950'>{title}</p>
                  <p className='mt-1 text-paragraph-sm text-text-sub-600'>
                    {body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
