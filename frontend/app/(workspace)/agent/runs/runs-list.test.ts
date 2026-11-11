import { expect, test } from 'bun:test';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Run } from './runs-data';
import { RunsList, matchesRunStatus, runTone, validEngineFilter } from './runs-list';

// The list reads the app router; a provider stub keeps this suite free of
// module mocks, which are process-wide and would reach every other suite.
const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

function run(status: Run['status'], latestStatus: Run['latest_status']): Run {
  return {
    id: 'thread-root',
    prompt: 'Fix the current thread status',
    model: 'gpt-5.6-sol',
    engine: 'codex',
    status,
    summary: null,
    duration_ms: null,
    project_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    connector: null,
    created_at: '2026-09-14T00:00:00.000Z',
    updated_at: '2026-09-14T00:01:00.000Z',
    latest_run_id: 'latest-turn',
    latest_status: latestStatus,
    latest_created_at: '2026-09-14T00:01:00.000Z',
    latest_updated_at: '2026-09-14T00:02:00.000Z',
  };
}

test('clears an engine filter that disappeared from the live snapshot', () => {
  expect(validEngineFilter('codex', ['opencode'])).toBe('all');
  expect(validEngineFilter('codex', ['codex', 'opencode'])).toBe('codex');
  expect(validEngineFilter('all', [])).toBe('all');
});

test('renders the latest turn status instead of the root turn status', () => {
  const html = renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(RunsList, {
        initialRuns: [run('completed', 'running')],
        initialError: false,
      }),
    ),
  );

  expect(html).toContain('bg-orange-500 animate-pulse');
  expect(html).toContain('bg-status-yellow-background text-status-yellow-text gap-1');
  expect(html).not.toContain('bg-status-lime-background text-status-lime-text gap-1');
});

test('filters by the latest failed turn after the root turn completed', () => {
  const failedThread = run('completed', 'failed');
  const completedThread = { ...run('completed', 'completed'), id: 'completed-thread' };

  expect([failedThread, completedThread].filter((item) => matchesRunStatus(item, 'error')))
    .toEqual([failedThread]);
});

test('treats a queued latest turn as live', () => {
  const queuedThread = run('completed', 'queued');
  expect(runTone(queuedThread)).toBe('live');
  expect(matchesRunStatus(queuedThread, 'live')).toBe(true);
});

test('offers older threads only when the backend sent a next cursor', () => {
  const render = (initialNextCursor?: string | null) =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: router },
        createElement(RunsList, {
          initialRuns: [run('completed', 'completed')],
          initialNextCursor,
          initialError: false,
        }),
      ),
    );

  expect(render('next-page')).toContain('Show older threads');
  expect(render(null)).not.toContain('Show older threads');
  expect(render()).not.toContain('Show older threads');
});
