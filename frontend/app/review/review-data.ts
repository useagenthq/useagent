/**
 * Seed content for the Code Review surface — skynet-a's take on verification-gated
 * PR review. A list of open pull requests, each carrying grouped, adversarially
 * verified findings (bugs / security / duplication / style) plus a short embedded
 * chat thread on one finding (the "chat with the review" flow).
 *
 * No icons live here — icon component refs are attached in the client layer so
 * nothing crosses the server→client boundary through this module.
 */

/** AlignUI Avatar color union (see components/ui/avatar). */
export type AvatarColor = 'gray' | 'yellow' | 'blue' | 'sky' | 'purple' | 'red';
/** AlignUI Badge color union (see components/ui/badge). */
export type BadgeColor =
  | 'gray'
  | 'blue'
  | 'orange'
  | 'red'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'sky'
  | 'pink'
  | 'teal';

export type FindingCategory = 'bug' | 'security' | 'duplication' | 'style';

/** A short, syntax-free source excerpt with one flagged line. */
export interface CodeExcerpt {
  /** Line number of the first rendered line. */
  startLine: number;
  /** ~4 lines of source, rendered mono. */
  lines: string[];
  /** 0-based index into `lines` for the flagged line. */
  highlight: number;
}

export interface ChatMessage {
  role: 'user' | 'skynet';
  text: string;
}

/** A structured before/after row for a proposed fix. */
export interface DiffRow {
  field: string;
  before: string;
  after: string;
  status: 'added' | 'changed' | 'removed';
}

export interface Finding {
  id: string;
  category: FindingCategory;
  title: string;
  /** `path:line` shown as a mono link. */
  location: string;
  /** Two-line explanation of the finding. */
  explanation: string;
  excerpt: CodeExcerpt;
  /** Optional structured diff rendered under the excerpt. */
  proposedChange?: DiffRow[];
  /** Seeded conversation for the "chat with the review" flow. */
  thread?: ChatMessage[];
}

export interface PullRequest {
  id: string;
  repo: string;
  number: number;
  title: string;
  author: { name: string; initials: string; color: AvatarColor };
  branch: string;
  ci: 'passing' | 'running' | 'failing';
  /** Relative timestamp, e.g. "14m ago". */
  time: string;
  /** When true the PR reads as clean — a green "Approved" chip, no findings. */
  approved?: boolean;
  /** Green "Ready to merge" bar when true; a blocked bar otherwise. */
  mergeReady?: boolean;
  /** Verification-gate stat: adversarially-refuted finding candidates. */
  refuted: number;
  findings: Finding[];
}

/* -------------------------------------------------------------------------- */
/*  Category metadata (labels + Badge colors). Icons attach in the client.     */
/* -------------------------------------------------------------------------- */

export const categoryMeta: Record<
  FindingCategory,
  { label: string; chipLabel: string; color: BadgeColor }
> = {
  bug: { label: 'Bugs', chipLabel: 'Bug', color: 'red' },
  security: { label: 'Security', chipLabel: 'Security', color: 'orange' },
  duplication: { label: 'Duplication', chipLabel: 'Duplication', color: 'blue' },
  style: { label: 'Style', chipLabel: 'Style', color: 'gray' },
};

/** Stable order for the detail's grouped sections and the row summary chips. */
export const categoryOrder: FindingCategory[] = [
  'bug',
  'security',
  'duplication',
  'style',
];

/** CI state → dot color class + label. */
export const ciMeta: Record<
  PullRequest['ci'],
  { dotClass: string; label: string }
> = {
  passing: { dotClass: 'bg-success-base', label: 'CI passing' },
  running: { dotClass: 'bg-away-base', label: 'CI running' },
  failing: { dotClass: 'bg-error-base', label: 'CI failing' },
};

/** Compact per-category count label for the list rows, e.g. "2 bugs", "3 nits". */
export function summaryLabel(category: FindingCategory, n: number): string {
  switch (category) {
    case 'bug':
      return `${n} ${n === 1 ? 'bug' : 'bugs'}`;
    case 'security':
      return `${n} security`;
    case 'duplication':
      return `${n} ${n === 1 ? 'dupe' : 'dupes'}`;
    case 'style':
      return `${n} ${n === 1 ? 'nit' : 'nits'}`;
  }
}

/** Count of findings in `category` for a PR. */
export function countByCategory(
  pr: PullRequest,
  category: FindingCategory,
): number {
  return pr.findings.filter((f) => f.category === category).length;
}

/* -------------------------------------------------------------------------- */
/*  Mock pull requests                                                         */
/* -------------------------------------------------------------------------- */

export const pullRequests: PullRequest[] = [
  {
    id: 'pr-142',
    repo: 'skynet-app',
    number: 142,
    title: 'Add rate limiting to API gateway',
    author: { name: 'Maya Chen', initials: 'MC', color: 'blue' },
    branch: 'feat/rate-limiting',
    ci: 'passing',
    time: '14m ago',
    mergeReady: true,
    refuted: 3,
    findings: [
      {
        id: 'f-142-bug-1',
        category: 'bug',
        title: 'Sliding window resets on every request',
        location: 'gateway/limiter.ts:42',
        explanation:
          '`windowStart` is reassigned on each call, so the window never elapses. After the first burst every client stays throttled indefinitely.',
        excerpt: {
          startLine: 40,
          lines: [
            'export function allow(key: string) {',
            '  const now = Date.now();',
            '  windowStart = now; // reset on every call — window never expires',
            '  return hits(key) < LIMIT;',
          ],
          highlight: 2,
        },
        proposedChange: [
          {
            field: 'reset guard',
            before: '—',
            after: 'now − windowStart ≥ WINDOW_MS',
            status: 'added',
          },
          {
            field: 'windowStart',
            before: 'each call',
            after: 'per window',
            status: 'changed',
          },
          {
            field: 'stale reset',
            before: 'windowStart = now',
            after: 'dropped',
            status: 'removed',
          },
        ],
        thread: [
          {
            role: 'user',
            text: 'Is this really wrong? We do want to track the newest request time.',
          },
          {
            role: 'skynet',
            text: "Tracking the newest time is fine, but assigning it to `windowStart` is what breaks it — the window's start should only advance once the previous window fully elapses. As written, `now - windowStart` is always ~0, so the limiter treats every request as the first in a fresh window and never resets the count. Move the reset behind an `if (now - windowStart >= WINDOW_MS)` guard.",
          },
        ],
      },
      {
        id: 'f-142-bug-2',
        category: 'bug',
        title: 'Off-by-one lets the 101st request through',
        location: 'gateway/limiter.ts:58',
        explanation:
          'The comparison uses `<=` against `LIMIT`, admitting one request beyond the configured ceiling on every window.',
        excerpt: {
          startLine: 56,
          lines: [
            'function hits(key: string) {',
            '  const count = buckets.get(key) ?? 0;',
            '  return count <= LIMIT ? count : LIMIT; // <= admits LIMIT + 1',
            '}',
          ],
          highlight: 2,
        },
      },
      {
        id: 'f-142-sec-1',
        category: 'security',
        title: 'Client identity trusts a spoofable header',
        location: 'gateway/identity.ts:17',
        explanation:
          'The rate-limit key is derived from `X-Forwarded-For`, which any client can set. An attacker rotates the header to bypass the limit entirely.',
        excerpt: {
          startLine: 15,
          lines: [
            'export function clientKey(req: Request) {',
            '  // trusts a header the client fully controls',
            "  return req.headers.get('x-forwarded-for') ?? 'anon';",
            '}',
          ],
          highlight: 2,
        },
      },
      {
        id: 'f-142-dup-1',
        category: 'duplication',
        title: 'Token-bucket logic duplicated from throttle middleware',
        location: 'gateway/limiter.ts:12',
        explanation:
          'This bucket refill loop is a near-verbatim copy of `middleware/throttle.ts:31`. Extract a shared `tokenBucket()` helper instead of maintaining two copies.',
        excerpt: {
          startLine: 12,
          lines: [
            'const elapsed = now - lastRefill;',
            'const refill = Math.floor(elapsed / INTERVAL) * RATE;',
            'tokens = Math.min(CAPACITY, tokens + refill);',
            'lastRefill = now;',
          ],
          highlight: 1,
        },
      },
      {
        id: 'f-142-style-1',
        category: 'style',
        title: '`LIMIT` is never reassigned — prefer const',
        location: 'gateway/limiter.ts:4',
        explanation:
          'Declared with `let` but only assigned once. Use `const` so the ceiling cannot be mutated by accident.',
        excerpt: {
          startLine: 4,
          lines: [
            'let LIMIT = 100;',
            'let WINDOW_MS = 60000;',
            'const buckets = new Map<string, number>();',
            'let windowStart = Date.now();',
          ],
          highlight: 0,
        },
      },
      {
        id: 'f-142-style-2',
        category: 'style',
        title: 'Magic number should be a named constant',
        location: 'gateway/limiter.ts:5',
        explanation:
          '`60000` appears inline for the window duration. Name it `WINDOW_MS` at module scope so the intent reads at the call site.',
        excerpt: {
          startLine: 5,
          lines: [
            'let WINDOW_MS = 60000; // 60_000 → name the unit',
            'const buckets = new Map<string, number>();',
            'let windowStart = Date.now();',
            'let hitsInWindow = 0;',
          ],
          highlight: 0,
        },
      },
    ],
  },
  {
    id: 'pr-88',
    repo: 'skynet-web',
    number: 88,
    title: 'Refactor auth session store',
    author: { name: 'Diego Ruiz', initials: 'DR', color: 'purple' },
    branch: 'refactor/session-store',
    ci: 'running',
    time: '1h ago',
    mergeReady: false,
    refuted: 2,
    findings: [
      {
        id: 'f-88-sec-1',
        category: 'security',
        title: 'Session token logged at debug level',
        location: 'auth/session.ts:73',
        explanation:
          'The raw session token is written to the debug logger. Debug logs ship to the aggregator, exposing live tokens to anyone with log access.',
        excerpt: {
          startLine: 71,
          lines: [
            'async function persist(session: Session) {',
            "  logger.debug('persisting session', { token: session.token });",
            '  await store.set(session.id, session);',
            '}',
          ],
          highlight: 1,
        },
      },
      {
        id: 'f-88-dup-1',
        category: 'duplication',
        title: 'Cookie serialization copied from legacy store',
        location: 'auth/session.ts:104',
        explanation:
          'This `serializeCookie` block mirrors `auth/legacy-store.ts:88`. Both should call one shared serializer so flag changes stay in sync.',
        excerpt: {
          startLine: 104,
          lines: [
            'const parts = [`${name}=${encodeURIComponent(value)}`];',
            "if (opts.httpOnly) parts.push('HttpOnly');",
            "if (opts.secure) parts.push('Secure');",
            "return parts.join('; ');",
          ],
          highlight: 0,
        },
      },
      {
        id: 'f-88-dup-2',
        category: 'duplication',
        title: 'TTL math repeated across three call sites',
        location: 'auth/session.ts:52',
        explanation:
          'The `Date.now() + ttl * 1000` expiry calculation appears here, at line 61, and at line 90. Hoist an `expiresAt(ttl)` helper.',
        excerpt: {
          startLine: 52,
          lines: [
            'const expiresAt = Date.now() + ttl * 1000;',
            'session.expiresAt = expiresAt;',
            'await store.set(session.id, session, { expiresAt });',
            "metrics.record('session.created');",
          ],
          highlight: 0,
        },
      },
    ],
  },
  {
    id: 'pr-139',
    repo: 'skynet-app',
    number: 139,
    title: 'Bump Next.js to 16.1',
    author: { name: 'Priya Nair', initials: 'PN', color: 'yellow' },
    branch: 'chore/next-16-1',
    ci: 'failing',
    time: '3h ago',
    mergeReady: false,
    refuted: 1,
    findings: [
      {
        id: 'f-139-bug-1',
        category: 'bug',
        title: 'Removed `experimental.turbo` key still referenced',
        location: 'next.config.ts:22',
        explanation:
          'Next 16 moved `turbo` out of `experimental`. The old path resolves to `undefined`, silently disabling the Turbopack loader overrides.',
        excerpt: {
          startLine: 20,
          lines: [
            'export default {',
            '  experimental: {',
            '    turbo: { rules: svgLoader }, // moved to top-level `turbopack` in 16',
            '  },',
          ],
          highlight: 2,
        },
      },
      {
        id: 'f-139-style-1',
        category: 'style',
        title: 'Pinned patch version blocks security bumps',
        location: 'package.json:14',
        explanation:
          '`next` is pinned to an exact patch. Use a caret range so patched releases flow in without a manual bump.',
        excerpt: {
          startLine: 13,
          lines: [
            '  "dependencies": {',
            '    "next": "16.1.0",',
            '    "react": "^19.0.0",',
            '    "react-dom": "^19.0.0"',
          ],
          highlight: 1,
        },
      },
    ],
  },
  {
    id: 'pr-57',
    repo: 'skynet-infra',
    number: 57,
    title: 'Cache warmer cron for edge nodes',
    author: { name: 'Sam Okafor', initials: 'SO', color: 'gray' },
    branch: 'feat/cache-warmer',
    ci: 'passing',
    time: '5h ago',
    mergeReady: true,
    refuted: 4,
    findings: [
      {
        id: 'f-57-dup-1',
        category: 'duplication',
        title: 'Region list duplicated from deploy manifest',
        location: 'cron/warmer.ts:9',
        explanation:
          'The hard-coded edge regions repeat `deploy/regions.ts`. Import the canonical list so a new region only needs registering once.',
        excerpt: {
          startLine: 9,
          lines: [
            "const REGIONS = ['iad', 'sfo', 'fra', 'sin', 'gru'];",
            'for (const region of REGIONS) {',
            '  await warm(region);',
            '}',
          ],
          highlight: 0,
        },
      },
      {
        id: 'f-57-style-1',
        category: 'style',
        title: 'Await inside loop serializes the warm-up',
        location: 'cron/warmer.ts:11',
        explanation:
          'Awaiting each region in turn makes the cron run five times slower than needed. Fan out with `Promise.all` over the region list.',
        excerpt: {
          startLine: 10,
          lines: [
            'for (const region of REGIONS) {',
            '  await warm(region); // serial — prefer Promise.all',
            '}',
            "logger.info('cache warm complete');",
          ],
          highlight: 1,
        },
      },
    ],
  },
  {
    id: 'pr-131',
    repo: 'skynet-app',
    number: 131,
    title: 'Fix flaky checkout E2E test',
    author: { name: 'Lena Fischer', initials: 'LF', color: 'sky' },
    branch: 'fix/flaky-checkout',
    ci: 'passing',
    time: '1d ago',
    approved: true,
    mergeReady: true,
    refuted: 0,
    findings: [],
  },
];
