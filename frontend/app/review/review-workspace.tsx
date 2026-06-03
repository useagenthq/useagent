'use client';

import {
  RiChat3Line,
  RiExternalLinkLine,
  RiGitPullRequestLine,
  RiGithubLine,
  RiInboxLine,
} from '@remixicon/react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Avatar } from '@/components/base/avatar/avatar';
import { Chip } from '@/components/base/badges/chip';
import { BackendUnreachable } from '@/components/shared/backend-unreachable';
import { relativeTime } from '@/utils/format';
import { fetchPulls, type PullRequestItem, type PullsResult } from './review-api';

/**
 * Deep-link to the New Task composer with the PR already described in the
 * prompt, so the run can read it deeply via the GitHub PR-detail gateway tool.
 * The repo is preselected too (when it matches an available repo) so the agent
 * has the code alongside the PR.
 */
function discussHref(pr: PullRequestItem): string {
  const prompt =
    `Let's discuss pull request ${pr.repo} #${pr.number}: "${pr.title}". ` +
    'Read it in detail - the diff, description, and review comments - using the ' +
    'GitHub PR detail tool, then summarize what it changes and flag any risks. ' +
    pr.url;
  return `/agent/new?${new URLSearchParams({ repo: pr.repo, prompt }).toString()}`;
}

/** First two letters of the author login — the avatar fallback when GitHub has
 *  no avatar url. */
function initials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

/** One PR row: title links out to GitHub, a "Discuss" action opens a run
 *  pre-seeded with the PR context. Keeps the list's visual language (mono repo
 *  #num, title, author, state badge, relative time). */
function PrRow({ pr }: { pr: PullRequestItem }) {
  return (
    <div className='flex flex-col gap-2 rounded-2xl border border-border-button-default bg-background-primary-default px-4 py-3.5 transition-colors hover:bg-background-secondary-default'>
      <div className='flex items-center justify-between gap-2'>
        <span className='[font-family:var(--font-mono)] text-caption-1-medium text-text-tertiary'>
          {pr.repo} #{pr.number}
        </span>
        <span className='shrink-0 text-caption-1-regular text-text-tertiary'>
          {relativeTime(pr.updated_at)}
        </span>
      </div>

      <a
        href={pr.url}
        target='_blank'
        rel='noopener noreferrer'
        className='group/title rounded outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring'
      >
        <h3 className='line-clamp-2 text-body-2-medium text-text-primary group-hover/title:underline'>
          {pr.title}
        </h3>
      </a>

      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <Avatar
            size='xs'
            color='neutral'
            src={pr.author_avatar_url || undefined}
            alt={pr.author}
            initials={initials(pr.author)}
          />
          <span className='text-caption-1-medium text-text-secondary'>{pr.author}</span>
          {pr.draft ? (
            <Chip color='gray'>
              Draft
            </Chip>
          ) : (
            <Chip color='lime'>
              Open
            </Chip>
          )}
        </div>

        <div className='flex shrink-0 items-center gap-1'>
          <Link
            href={discussHref(pr)}
            className='inline-flex items-center gap-1 rounded-lg px-2 py-1 text-caption-1-medium text-text-secondary outline-none transition-colors hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring'
          >
            <RiChat3Line className='size-3.5' aria-hidden />
            Discuss
          </Link>
          <a
            href={pr.url}
            target='_blank'
            rel='noopener noreferrer'
            className='inline-flex items-center gap-1 rounded-lg px-2 py-1 text-caption-1-medium text-text-tertiary outline-none transition-colors hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring'
          >
            <RiExternalLinkLine className='size-3.5' aria-hidden />
            GitHub
          </a>
        </div>
      </div>
    </div>
  );
}

/** Shared empty/error frame — a centered icon tile + title + body. */
function StateCard({
  icon: Icon,
  tone,
  title,
  body,
}: {
  icon: typeof RiGithubLine;
  tone: 'neutral' | 'warning';
  title: string;
  body: string;
}) {
  return (
    <div className='flex flex-col items-center gap-2 rounded-2xl border border-border-button-default bg-background-secondary-default px-6 py-12 text-center'>
      <span
        className={
          tone === 'warning'
            ? 'flex size-10 items-center justify-center rounded-full bg-status-yellow-background'
            : 'flex size-10 items-center justify-center rounded-full bg-background-tertiary-default'
        }
      >
        <Icon
          className={tone === 'warning' ? 'size-5 text-yellow-600' : 'size-5 text-text-secondary'}
          aria-hidden
        />
      </span>
      <p className='text-body-medium text-text-primary'>{title}</p>
      <p className='max-w-sm text-body-2-regular text-text-secondary'>{body}</p>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className='flex flex-col gap-2'>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className='h-[92px] animate-pulse rounded-2xl border border-border-button-default bg-background-secondary-default'
        />
      ))}
    </div>
  );
}

type State =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'ready'; result: PullsResult };

export function ReviewWorkspace() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const result = await fetchPulls();
      setState({ kind: 'ready', result });
    } catch {
      setState({ kind: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const count =
    state.kind === 'ready' && state.result.configured && !state.result.error
      ? state.result.pulls.length
      : null;

  return (
    <div className='h-full overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 py-8 sm:px-8'>
        <header className='flex flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <h1 className='text-title-2-medium text-text-primary'>Pull requests</h1>
            {count !== null ? (
              <Chip color='gray'>
                {count}
              </Chip>
            ) : null}
          </div>
          <p className='text-body-2-regular text-text-secondary'>
            Open pull requests across your connected GitHub repositories.
          </p>
        </header>

        {state.kind === 'loading' ? <LoadingRows /> : null}

        {state.kind === 'unreachable' ? <BackendUnreachable onRetry={() => void load()} /> : null}

        {state.kind === 'ready' && !state.result.configured ? (
          <StateCard
            icon={RiGithubLine}
            tone='neutral'
            title='GitHub not connected'
            body='Connect a GitHub account or install the useAgent app to review your organization pull requests here.'
          />
        ) : null}

        {state.kind === 'ready' && state.result.configured && state.result.error ? (
          <StateCard
            icon={RiGithubLine}
            tone='warning'
            title="Couldn't load pull requests"
            body='GitHub is connected but the pull-request fetch failed. This is a GitHub-side error, not an empty list - try again in a moment.'
          />
        ) : null}

        {state.kind === 'ready' &&
        state.result.configured &&
        !state.result.error &&
        state.result.pulls.length === 0 ? (
          <StateCard
            icon={RiInboxLine}
            tone='neutral'
            title='No open pull requests'
            body='Every accessible repository is clear right now. New PRs show up here as they are opened.'
          />
        ) : null}

        {state.kind === 'ready' &&
        state.result.configured &&
        !state.result.error &&
        state.result.pulls.length > 0 ? (
          <div className='flex flex-col gap-2'>
            {state.result.pulls.map((pr) => (
              <PrRow key={pr.id} pr={pr} />
            ))}
            {state.result.truncated ? (
              <p className='flex items-center gap-1.5 px-1 pt-1 text-caption-1-regular text-text-tertiary'>
                <RiGitPullRequestLine className='size-3.5 shrink-0' aria-hidden />
                Showing the most recently updated pull requests; some repositories were not scanned.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
