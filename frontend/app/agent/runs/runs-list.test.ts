import { expect, test } from 'bun:test';

import { validEngineFilter } from './runs-list';

test('clears an engine filter that disappeared from the live snapshot', () => {
  expect(validEngineFilter('codex', ['opencode'])).toBe('all');
  expect(validEngineFilter('codex', ['codex', 'opencode'])).toBe('codex');
  expect(validEngineFilter('all', [])).toBe('all');
});
