'use client';

import { RiGitBranchLine } from '@remixicon/react';
import { useState } from 'react';

import * as Avatar from '@/components/ui/avatar';
import * as Badge from '@/components/ui/badge';
import { cn } from '@/utils/cn';
import { ReviewDetail } from './review-detail';
import {
  categoryMeta,
  categoryOrder,
  ciMeta,
  countByCategory,
  pullRequests,
  type PullRequest,
  summaryLabel,
} from './review-data';

/** One selectable PR row in the left list. */
function PrRow({
  pr,
  selected,
  onSelect,
}: {
  pr: PullRequest;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type='button'
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-2 rounded-xl border px-3 py-3 text-left transition-colors',
        selected
          ? 'border-stroke-sub-300 bg-bg-weak-50'
          : 'border-transparent hover:bg-bg-weak-50',
      )}
    >
      <div className='flex items-center justify-between gap-2'>
        <span className='[font-family:var(--font-mono)] text-label-xs text-text-soft-400'>
          {pr.repo} #{pr.number}
        </span>
        <span className='inline-flex shrink-0 items-center gap-1.5 text-paragraph-xs text-text-soft-400'>
          <span
            className={cn('size-2 shrink-0 rounded-full', ciMeta[pr.ci].dotClass)}
            aria-hidden
          />
          {pr.time}
        </span>
      </div>

      <h3 className='line-clamp-2 text-label-sm text-text-strong-950'>
        {pr.title}
      </h3>

      <div className='flex items-center gap-1.5'>
        <Avatar.Root size='20' color={pr.author.color}>
          {pr.author.initials}
        </Avatar.Root>
        <Badge.Root
          variant='lighter'
          color='gray'
          className='gap-1 [font-family:var(--font-mono)]'
        >
          <RiGitBranchLine className='size-3 shrink-0' aria-hidden />
          {pr.branch}
        </Badge.Root>
      </div>

      <div className='flex flex-wrap items-center gap-1.5'>
        {pr.approved ? (
          <Badge.Root variant='light' color='green'>
            Approved
          </Badge.Root>
        ) : (
          categoryOrder
            .filter((category) => countByCategory(pr, category) > 0)
            .map((category) => (
              <Badge.Root
                key={category}
                variant='light'
                color={categoryMeta[category].color}
              >
                {summaryLabel(category, countByCategory(pr, category))}
              </Badge.Root>
            ))
        )}
      </div>
    </button>
  );
}

export function ReviewWorkspace() {
  const [selectedId, setSelectedId] = useState(pullRequests[0].id);
  const selected =
    pullRequests.find((pr) => pr.id === selectedId) ?? pullRequests[0];

  return (
    <div className='flex h-full min-h-0'>
      {/* Left: PR list */}
      <aside className='flex w-[340px] shrink-0 flex-col border-r border-stroke-soft-200'>
        <div className='flex items-center gap-2 border-b border-stroke-soft-200 px-4 py-3.5'>
          <h2 className='text-label-lg text-text-strong-950'>Review</h2>
          <Badge.Root variant='lighter' color='gray'>
            {pullRequests.length}
          </Badge.Root>
        </div>
        <div className='flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5'>
          {pullRequests.map((pr) => (
            <PrRow
              key={pr.id}
              pr={pr}
              selected={pr.id === selected.id}
              onSelect={() => setSelectedId(pr.id)}
            />
          ))}
        </div>
      </aside>

      {/* Right: review detail (remounts per PR so its local state resets) */}
      <section className='min-w-0 flex-1'>
        <ReviewDetail key={selected.id} pr={selected} />
      </section>
    </div>
  );
}
