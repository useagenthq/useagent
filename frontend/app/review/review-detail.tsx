'use client';

import {
  RiArrowDownSLine,
  RiBrushLine,
  RiBugLine,
  RiCheckLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiGitBranchLine,
  RiGitMergeLine,
  RiShieldCheckLine,
  RiShieldKeyholeLine,
  RiSparkling2Line,
  RiTimeLine,
} from '@remixicon/react';
import { type ComponentType, useState } from 'react';

import * as Avatar from '@/components/ui/avatar';
import * as Badge from '@/components/ui/badge';
import * as Button from '@/components/ui/button';
import { cn } from '@/utils/cn';
import { FindingCard } from './finding-card';
import {
  categoryMeta,
  categoryOrder,
  ciMeta,
  type FindingCategory,
  type PullRequest,
} from './review-data';

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

const categoryIcon: Record<FindingCategory, IconComponent> = {
  bug: RiBugLine,
  security: RiShieldKeyholeLine,
  duplication: RiFileCopyLine,
  style: RiBrushLine,
};

/** Merge-bar tone + copy, derived from readiness and CI state. */
function mergeBar(pr: PullRequest): {
  tone: 'ready' | 'blocked' | 'pending';
  text: string;
} {
  const ci = ciMeta[pr.ci].label;
  if (pr.mergeReady) {
    return {
      tone: 'ready',
      text: `Ready to merge · ${ci} · 1 approval required`,
    };
  }
  if (pr.ci === 'failing') {
    return {
      tone: 'blocked',
      text: `Merge blocked · ${ci} · fix checks to continue`,
    };
  }
  return { tone: 'pending', text: `Awaiting checks · ${ci} · 1 approval required` };
}

const mergeToneStyles: Record<
  ReturnType<typeof mergeBar>['tone'],
  { className: string; icon: IconComponent }
> = {
  ready: {
    className: 'bg-success-lighter text-success-base',
    icon: RiGitMergeLine,
  },
  blocked: {
    className: 'bg-error-lighter text-error-base',
    icon: RiErrorWarningLine,
  },
  pending: {
    className: 'bg-warning-lighter text-warning-base',
    icon: RiTimeLine,
  },
};

/** A collapsible findings section for one category. */
function FindingSection({
  category,
  count,
  open,
  onToggle,
  children,
}: {
  category: FindingCategory;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const meta = categoryMeta[category];
  const Icon = categoryIcon[category];
  return (
    <section className='flex flex-col gap-3'>
      <button
        type='button'
        onClick={onToggle}
        aria-expanded={open}
        className='group flex w-full items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-base'
      >
        <Icon
          className='size-[18px] shrink-0 text-text-sub-600'
          aria-hidden
        />
        <h3 className='text-label-sm text-text-strong-950'>{meta.label}</h3>
        <Badge.Root variant='light' color={meta.color}>
          {count}
        </Badge.Root>
        <RiArrowDownSLine
          aria-hidden
          className={cn(
            'ml-auto size-5 shrink-0 text-text-soft-400 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && <div className='flex flex-col gap-3'>{children}</div>}
    </section>
  );
}

export function ReviewDetail({ pr }: { pr: PullRequest }) {
  const [openSections, setOpenSections] = useState<Set<FindingCategory>>(
    () => new Set(categoryOrder),
  );
  const [expandedId, setExpandedId] = useState<string | null>(
    () => pr.findings.find((f) => f.thread)?.id ?? null,
  );

  const groups = categoryOrder
    .map((category) => ({
      category,
      findings: pr.findings.filter((f) => f.category === category),
    }))
    .filter((group) => group.findings.length > 0);

  const bar = mergeBar(pr);
  const barStyle = mergeToneStyles[bar.tone];
  const BarIcon = barStyle.icon;

  const toggleSection = (category: FindingCategory) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

  return (
    <div className='h-full overflow-y-auto'>
      <div className='animate-ai-fade-up mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 py-6 sm:px-8'>
        {/* Header */}
        <header className='flex flex-col gap-3'>
          <div className='flex flex-wrap items-start justify-between gap-3'>
            <div className='flex min-w-0 flex-col gap-1.5'>
              <span className='[font-family:var(--font-mono)] text-label-xs text-text-soft-400'>
                {pr.repo} #{pr.number}
              </span>
              <h1 className='text-title-h5 text-text-strong-950'>{pr.title}</h1>
            </div>
            <div className='flex shrink-0 items-center gap-2'>
              <Button.Root className="rounded-full" variant='primary' mode='filled' size='small'>
                <Button.Icon as={RiSparkling2Line} />
                Auto-fix with Skynet
              </Button.Root>
              <Button.Root className="rounded-full"
                variant='neutral'
                mode='stroke'
                size='small'
                disabled={pr.approved}
              >
                <Button.Icon as={RiCheckLine} />
                {pr.approved ? 'Approved' : 'Approve'}
              </Button.Root>
            </div>
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <Avatar.Root size='24' color={pr.author.color}>
              {pr.author.initials}
            </Avatar.Root>
            <span className='text-label-xs text-text-sub-600'>
              {pr.author.name}
            </span>
            <Badge.Root
              variant='lighter'
              color='gray'
              className='gap-1 [font-family:var(--font-mono)]'
            >
              <RiGitBranchLine className='size-3 shrink-0' aria-hidden />
              {pr.branch}
            </Badge.Root>
            <span className='inline-flex items-center gap-1.5 text-label-xs text-text-soft-400'>
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  ciMeta[pr.ci].dotClass,
                )}
                aria-hidden
              />
              {ciMeta[pr.ci].label}
            </span>
          </div>
        </header>

        {/* Verification-gate banner */}
        <div className='flex items-start gap-2.5 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 px-3.5 py-3'>
          <RiShieldCheckLine
            className='mt-0.5 size-[18px] shrink-0 text-success-base'
            aria-hidden
          />
          <div className='flex flex-col gap-0.5'>
            <span className='text-mono-label text-text-sub-600'>Verified</span>
            <p className='text-paragraph-xs text-text-sub-600'>
              Every finding adversarially checked before display - {pr.refuted}{' '}
              {pr.refuted === 1 ? 'candidate' : 'candidates'} refuted.
            </p>
          </div>
        </div>

        {/* Merge bar */}
        <div
          className={cn(
            'flex items-center gap-2 rounded-xl px-3.5 py-3 text-label-sm',
            barStyle.className,
          )}
        >
          <BarIcon className='size-[18px] shrink-0' aria-hidden />
          <span>{bar.text}</span>
        </div>

        {/* Findings, grouped by category */}
        {groups.length > 0 ? (
          <div className='flex flex-col gap-6'>
            {groups.map(({ category, findings }) => (
              <FindingSection
                key={category}
                category={category}
                count={findings.length}
                open={openSections.has(category)}
                onToggle={() => toggleSection(category)}
              >
                {findings.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    expanded={expandedId === finding.id}
                    onToggle={() =>
                      setExpandedId((prev) =>
                        prev === finding.id ? null : finding.id,
                      )
                    }
                  />
                ))}
              </FindingSection>
            ))}
          </div>
        ) : (
          <div className='flex flex-col items-center gap-2 rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 px-6 py-12 text-center'>
            <span className='flex size-10 items-center justify-center rounded-full bg-success-lighter'>
              <RiCheckLine className='size-5 text-success-base' aria-hidden />
            </span>
            <p className='text-label-md text-text-strong-950'>All clear</p>
            <p className='text-paragraph-sm text-text-sub-600'>
              No findings survived verification - this PR is ready to merge.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
