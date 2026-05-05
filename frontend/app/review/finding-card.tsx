'use client';

import {
  RiArrowUpLine,
  RiChat1Line,
  RiFileCodeLine,
  RiSparkling2Line,
  RiThumbDownLine,
  RiThumbUpLine,
} from '@remixicon/react';
import { type ComponentType, useState } from 'react';

import { AsteriskMark } from '@/components/foundations/brand/asterisk-mark';
import * as Avatar from '@/components/ui/avatar';
import * as Badge from '@/components/ui/badge';
import * as Button from '@/components/ui/button';
import * as Input from '@/components/ui/input';
import { cn } from '@/utils/cn';
import {
  categoryMeta,
  type DiffRow,
  type Finding,
  type FindingCategory,
} from './review-data';

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

/** Soft tint applied to the flagged excerpt line, keyed to the finding color. */
const highlightBg: Record<FindingCategory, string> = {
  bug: 'bg-error-lighter',
  security: 'bg-warning-lighter',
  duplication: 'bg-information-lighter',
  style: 'bg-bg-weak-50',
};

/** Small ghost icon action (thumbs up/down, discuss). */
function RowAction({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type='button'
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex size-7 items-center justify-center rounded-lg transition-colors',
        active
          ? 'bg-bg-weak-50 text-text-strong-950'
          : 'text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-sub-600',
      )}
    >
      <Icon className='size-4' aria-hidden />
    </button>
  );
}

/** Bordered, mono source excerpt with one tinted, flagged line. */
function Excerpt({ finding }: { finding: Finding }) {
  const { startLine, lines, highlight } = finding.excerpt;
  return (
    <div className='overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-weak-50'>
      <pre className='overflow-x-auto py-2 [font-family:var(--font-mono)] text-[13px] leading-6'>
        {lines.map((line, i) => (
          <div
            // Excerpt lines are static; index keys are stable here.
            key={i}
            className={cn(
              'flex px-3',
              i === highlight && highlightBg[finding.category],
            )}
          >
            <span
              aria-hidden
              className='mr-3 w-6 shrink-0 select-none text-right text-text-soft-400 tabular-nums'
            >
              {startLine + i}
            </span>
            <span className='min-w-0 flex-1 whitespace-pre text-text-strong-950'>
              {line}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}

const diffStatusStyle: Record<
  DiffRow['status'],
  { dot: string; label: string; after: string }
> = {
  added: { dot: 'bg-success-base', label: 'Added', after: 'text-success-base' },
  changed: {
    dot: 'bg-away-base',
    label: 'Changed',
    after: 'text-text-strong-950',
  },
  removed: {
    dot: 'bg-error-base',
    label: 'Removed',
    after: 'text-text-soft-400 line-through',
  },
};

/** Compact before/after table for findings whose fix is a clean field diff. */
function ProposedChange({ rows }: { rows: DiffRow[] }) {
  return (
    <div className='flex flex-col gap-1.5'>
      <span className='text-mono-label text-text-soft-400'>Proposed change</span>
      <div className='overflow-hidden rounded-xl border border-stroke-soft-200'>
        <div className='grid grid-cols-[1fr_1fr_1fr] bg-bg-weak-50 px-3 py-1.5 text-mono-label text-text-soft-400'>
          <span>Field</span>
          <span>Before</span>
          <span>After</span>
        </div>
        {rows.map((row) => {
          const style = diffStatusStyle[row.status];
          return (
            <div
              key={row.field}
              className='grid grid-cols-[1fr_1fr_1fr] items-center gap-2 border-t border-stroke-soft-200 px-3 py-2 text-paragraph-xs'
            >
              <span className='inline-flex items-center gap-1.5 text-text-sub-600'>
                <span
                  className={cn('size-1.5 shrink-0 rounded-full', style.dot)}
                  aria-hidden
                />
                {row.field}
              </span>
              <span className='truncate text-text-soft-400'>{row.before}</span>
              <span
                className={cn(
                  'truncate [font-family:var(--font-mono)]',
                  style.after,
                )}
              >
                {row.after}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The embedded "chat with the review" thread + a compact reply box. */
function ChatThread({ finding }: { finding: Finding }) {
  const [reply, setReply] = useState('');
  const thread = finding.thread ?? [];

  return (
    <div className='mt-3 flex flex-col gap-3 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-3'>
      {thread.length > 0 ? (
        thread.map((message, i) =>
          message.role === 'user' ? (
            <div key={i} className='flex items-start gap-2.5'>
              <Avatar.Root size='32' color='blue'>
                MC
              </Avatar.Root>
              <div className='rounded-xl rounded-tl-sm bg-bg-soft-200 px-3 py-2 text-paragraph-sm text-text-strong-950'>
                {message.text}
              </div>
            </div>
          ) : (
            <div key={i} className='flex items-start gap-2.5'>
              <span className='flex size-6 shrink-0 items-center justify-center rounded-full bg-bg-white-0 shadow-regular-xs'>
                <AsteriskMark className='size-3.5 text-text-strong-950' />
              </span>
              <div className='rounded-xl rounded-tl-sm bg-bg-white-0 px-3 py-2 text-paragraph-sm text-text-sub-600 shadow-regular-xs'>
                {message.text}
              </div>
            </div>
          ),
        )
      ) : (
        <p className='text-paragraph-xs text-text-soft-400'>
          Ask Skynet why this was flagged or how to resolve it.
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setReply('');
        }}
        className='flex items-center gap-2'
      >
        <Input.Root size='small' className='flex-1'>
          <Input.Wrapper>
            <Input.Input
              aria-label='Reply to Skynet about this finding'
              placeholder='Ask about this finding…'
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
          </Input.Wrapper>
        </Input.Root>
        <Button.Root
          type='submit'
          variant='neutral'
          mode='stroke'
          size='small'
          className='rounded-full w-9 shrink-0 px-0'
          aria-label='Send reply'
          disabled={!reply.trim()}
        >
          <Button.Icon as={RiArrowUpLine} />
        </Button.Root>
      </form>
    </div>
  );
}

export interface FindingCardProps {
  finding: Finding;
  expanded: boolean;
  onToggle: () => void;
}

export function FindingCard({ finding, expanded, onToggle }: FindingCardProps) {
  const meta = categoryMeta[finding.category];

  return (
    <article className='flex flex-col gap-3 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-4 shadow-regular-xs'>
      <div className='flex flex-col gap-2'>
        <div className='flex items-center gap-2'>
          <Badge.Root variant='light' color={meta.color}>
            {meta.chipLabel}
          </Badge.Root>
          <a
            href='#'
            className='inline-flex items-center gap-1 [font-family:var(--font-mono)] text-paragraph-xs text-text-sub-600 underline-offset-2 transition-colors hover:text-text-strong-950 hover:underline'
          >
            <RiFileCodeLine className='size-3.5 shrink-0' aria-hidden />
            {finding.location}
          </a>
        </div>
        <h4 className='text-label-sm text-text-strong-950'>{finding.title}</h4>
        <p className='text-paragraph-sm text-text-sub-600'>
          {finding.explanation}
        </p>
      </div>

      <Excerpt finding={finding} />

      {finding.proposedChange && (
        <ProposedChange rows={finding.proposedChange} />
      )}

      <div className='flex items-center gap-1'>
        <Button.Root className="rounded-full" variant='neutral' mode='stroke' size='xsmall'>
          <Button.Icon as={RiSparkling2Line} />
          Fix
        </Button.Root>
        <div className='ml-auto flex items-center gap-0.5'>
          <RowAction
            icon={RiChat1Line}
            label={expanded ? 'Hide discussion' : 'Discuss with Skynet'}
            active={expanded}
            onClick={onToggle}
          />
          <RowAction icon={RiThumbUpLine} label='Helpful' />
          <RowAction icon={RiThumbDownLine} label='Not helpful' />
        </div>
      </div>

      {expanded && <ChatThread finding={finding} />}
    </article>
  );
}
