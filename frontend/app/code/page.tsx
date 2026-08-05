import type { Metadata } from 'next';
import { RiArrowRightSLine, RiReactjsLine } from '@remixicon/react';

import { AppShell } from '@/components/shell/app-shell';
import { CodeViewer } from './code-viewer';
import { FileTreeRail } from './file-tree-rail';
import { TerminalStrip } from './terminal-strip';

export const metadata: Metadata = {
  title: 'Code — skynet-a',
  description: "The agent's live code workspace.",
};

/** A simplified RunTrace, rendered read-only in the code viewer. */
const snippet = `import { useState } from "react";
import * as Badge from "@/components/ui/badge";

interface RunStep {
  label: string;
  chip?: string;
}

/** A multi-repo trace: a summary header over a step timeline. */
export function RunTrace({
  steps,
  duration,
}: {
  steps: RunStep[];
  duration: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <button onClick={() => setOpen((v) => !v)}>
        <span>{steps.length} tools</span>
        <span>{duration}</span>
      </button>

      {open &&
        steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3">
            <span>{step.label}</span>
            {step.chip && <Badge.Root>{step.chip}</Badge.Root>}
          </div>
        ))}
    </div>
  );
}
`;

const crumbs = ['app', 'components'];

export default function CodePage() {
  return (
    <AppShell activeTab='code' sidebar={<FileTreeRail />}>
      <div className='mx-auto w-full max-w-4xl p-6 lg:p-8'>
        {/* File breadcrumb + live editing status */}
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <nav
            aria-label='File path'
            className='flex items-center gap-1 text-label-sm'
          >
            {crumbs.map((crumb) => (
              <span key={crumb} className='flex items-center gap-1'>
                <span className='text-text-sub-600'>{crumb}</span>
                <RiArrowRightSLine
                  className='size-4 text-text-soft-400'
                  aria-hidden
                />
              </span>
            ))}
            <span className='inline-flex items-center gap-1.5 text-text-strong-950'>
              <RiReactjsLine
                className='size-4 text-primary-base'
                aria-hidden
              />
              run-trace.tsx
            </span>
          </nav>

          <div className='flex shrink-0 items-center gap-2'>
            <span className='inline-flex items-center gap-1.5 rounded-full bg-success-lighter py-1 pl-1.5 pr-2.5 text-label-xs text-success-base'>
              <span
                className='size-2 rounded-full bg-success-base'
                aria-hidden
              />
              Agent editing
            </span>
            <span className='text-label-xs tabular-nums text-text-soft-400'>
              6m 12s
            </span>
          </div>
        </div>

        <div className='mt-4'>
          <CodeViewer code={snippet} lang='tsx' />
        </div>

        <div className='mt-4'>
          <TerminalStrip />
        </div>
      </div>
    </AppShell>
  );
}
