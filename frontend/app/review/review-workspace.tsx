'use client';

import {
  RiExternalLinkLine,
  RiGitPullRequestLine,
  RiGithubLine,
  RiInboxLine,
} from '@remixicon/react';
import { useCallback, useEffect, useState } from 'react';

import * as Avatar from '@/components/ui/avatar';
import * as Badge from '@/components/ui/badge';
import { BackendUnreachable } from '@/components/shared/backend-unreachable';
import { relativeTime } from '@/utils/format';
import { fetchPulls, type PullRequestItem, type PullsResult } from './review-api';

/** First two letters of the author login — the avatar fallback when GitHub has
 *  no avatar url. */
function initials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

/** One PR row: links out to the PR on GitHub. Keeps the list's visual language
 *  (mono repo #num, title, author, state badge, relative time). */
function PrRow({ pr }: { pr: PullRequestItem }) {
  return (
    <a
      href={pr.url}
      target='_blank'
      rel='noopener noreferrer'
      className='group flex flex-col gap-2 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 px-4 py-3.5 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950'
    >
      <div className='flex items-center justify-between gap-2'>
        <span className='[font-family:var(--font-mono)] text-label-xs text-text-soft-400'>
          {pr.repo} #{pr.number}
        </span>
        <span className='inline-flex shrink-0 items-center gap-1.5 text-paragraph-xs text-text-soft-400'>
          {relativeTime(pr.updated_at)}
          <RiExternalLinkLine
            className='size-3.5 opacity-0 transition-opacity group-hover:opacity-100'
            aria-hidden
          />
        </span>
      </div>

      <h3 className='line-clamp-2 text-label-sm text-text-strong-950'>{pr.title}</h3>

      <div className='flex flex-wrap items-center gap-1.5'>
        <Avatar.Root size='20' color='gray'>
          {pr.author_avatar_url ? (
            <Avatar.Image src={pr.author_avatar_url} alt={pr.author} />
          ) : (
            initials(pr.author)
          )}
        </Avatar.Root>
        <span className='text-label-xs text-text-sub-600'>{pr.author}</span>
        {pr.draft ? (
          <Badge.Root variant='lighter' color='gray'>
            Draft
          </Badge.Root>
        ) : (
          <Badge.Root variant='light' color='green'>
            Open
          </Badge.Root>
        )}
      </div>
    </a>
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
    <div className='flex flex-col items-center gap-2 rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 px-6 py-12 text-center'>
      <span
        className={
          tone === 'warning'
            ? 'flex size-10 items-center justify-center rounded-full bg-warning-lighter'
            : 'flex size-10 items-center justify-center rounded-full bg-bg-soft-200'
        }
      >
        <Icon
          className={tone === 'warning' ? 'size-5 text-warning-base' : 'size-5 text-text-sub-600'}
          aria-hidden
        />
      </span>
      <p className='text-label-md text-text-strong-950'>{title}</p>
      <p className='max-w-sm text-paragraph-sm text-text-sub-600'>{body}</p>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className='flex flex-col gap-2'>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className='h-[92px] animate-pulse rounded-2xl border border-stroke-soft-200 bg-bg-weak-50'
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
            <h1 className='text-title-h5 text-text-strong-950'>Pull requests</h1>
            {count !== null ? (
              <Badge.Root variant='lighter' color='gray'>
                {count}
              </Badge.Root>
            ) : null}
          </div>
          <p className='text-paragraph-sm text-text-sub-600'>
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
            body='Connect a GitHub account or install the Skynet app to review your organization pull requests here.'
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
              <p className='flex items-center gap-1.5 px-1 pt-1 text-paragraph-xs text-text-soft-400'>
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
