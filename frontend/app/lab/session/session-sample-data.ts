// Synthetic fixtures for the /lab/session sample. NOT vendored, NOT product data:
// one believable engineering task ("add rate limiting to the API gateway") encoded
// as the REAL canonical grammar so the live renderers (Timeline, WorkGroup, the
// session-ui chrome) draw it exactly as production would. Every tool row is a real
// ApiStep with a real code_json payload run through deriveTrace - nothing here
// reimplements a renderer, it only feeds one.

import type { PlanEntry } from "@/components/agent-ui/plan-checklist";
import type { TimelineMarker, TimelineNode } from "@/components/chat/timeline";
import type { ApiStep, EngineId } from "@/components/chat/types";
import type { AgentPanelRowModel } from "@/components/session-ui/agent-panel-row";
import type { ChangedFile } from "@/components/session-ui/changed-files";

// Deterministic clock (never Date.now(): SSR + client must agree, no hydration drift).
const T0 = Date.parse("2026-08-17T09:00:00.000Z");
let seq = 0;
function nextStamp(): string {
  return new Date(T0 + seq * 4000).toISOString();
}

type StepSpec = {
  readonly kind: ApiStep["kind"];
  readonly label: string;
  readonly chip?: string | null;
  readonly code?: Record<string, unknown>;
};

/** One synthetic ApiStep with an increasing idx + timestamp (drives WorkedForFold
 *  duration) and a JSON-encoded code_json the real deriveTrace/parse* read. */
export function sampleStep(spec: StepSpec): ApiStep {
  const idx = seq++;
  return {
    id: `sample-step-${idx}`,
    run_id: "sample-run",
    idx,
    kind: spec.kind,
    label: spec.label,
    chip: spec.chip ?? null,
    code_json: spec.code ? JSON.stringify(spec.code) : null,
    created_at: nextStamp(),
  };
}

function marker(key: string, m: TimelineMarker): TimelineNode {
  return { kind: "marker", key, marker: m };
}
function text(key: string, body: string): TimelineNode {
  return { kind: "text", key, text: body };
}
function reasoning(key: string, body: string): TimelineNode {
  return { kind: "reasoning", key, text: body };
}
function tool(spec: StepSpec): TimelineNode {
  const step = sampleStep(spec);
  return { kind: "tool", key: step.id, step };
}

// ── Real diff payloads (feed file-diff-view hunks + deriveTrace +adds/-dels) ──

const MIDDLEWARE_OLD = `export const chain = [
  authenticate,
  routeRequest,
];`;
const MIDDLEWARE_NEW = `export const chain = [
  authenticate,
  rateLimit({ perMinute: 100, keyBy: "orgId" }),
  routeRequest,
];`;

const RATE_LIMIT_FILE = `import type { Middleware } from "./types";

/** Token-bucket limiter keyed by org id: 100 requests / minute, refilled
 *  continuously. A drained bucket returns 429 with a Retry-After header. */
export function rateLimit(opts: { perMinute: number; keyBy: "orgId" }): Middleware {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  const refillPerMs = opts.perMinute / 60_000;
  return async (ctx, next) => {
    const key = ctx[opts.keyBy];
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: opts.perMinute, updatedAt: now };
    bucket.tokens = Math.min(opts.perMinute, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      ctx.status = 429;
      ctx.setHeader("Retry-After", String(Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)));
      return;
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    await next();
  };
}`;

/** ApiStep[] carrying real edit/write payloads - the source for FileDiffView
 *  hunks (filePatchesFromSteps) and the ChangedFilesCard (changedFilesFromTimeline). */
export const changeSetSteps: ApiStep[] = [
  sampleStep({
    kind: "file",
    label: "Write rate-limit.ts",
    code: {
      tool: "write",
      input: { file_path: "src/gateway/rate-limit.ts", content: RATE_LIMIT_FILE },
    },
  }),
  sampleStep({
    kind: "file",
    label: "Edit middleware.ts",
    code: {
      tool: "edit",
      input: {
        file_path: "src/gateway/middleware.ts",
        old_string: MIDDLEWARE_OLD,
        new_string: MIDDLEWARE_NEW,
      },
    },
  }),
  sampleStep({
    kind: "file",
    label: "Edit gateway.test.ts",
    code: {
      tool: "edit",
      input: {
        file_path: "src/gateway/__tests__/gateway.test.ts",
        old_string: `test("routes an authed request", async () => {
  const res = await call(app, authed());
  expect(res.status).toBe(200);
});`,
        new_string: `test("routes an authed request", async () => {
  const res = await call(app, authed());
  expect(res.status).toBe(200);
});

test("returns 429 + Retry-After past the org limit", async () => {
  for (let i = 0; i < 100; i++) await call(app, authed());
  const res = await call(app, authed());
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBeTruthy();
});`,
      },
    },
  }),
];

/** Aggregated changed-files entries (with honest line stats where derivable). */
export const changedFiles: ChangedFile[] = [
  { path: "src/gateway/rate-limit.ts", kind: "add", additions: 24, deletions: 0 },
  { path: "src/gateway/middleware.ts", kind: "edit", additions: 4, deletions: 3 },
  { path: "src/gateway/__tests__/gateway.test.ts", kind: "edit", additions: 8, deletions: 4 },
  { path: "docs/api/rate-limits.md", kind: "add", additions: 31, deletions: 0 },
];

// ── The believable conversation (oldest -> newest) ───────────────────────────

export type SampleTurn = {
  readonly id: string;
  readonly engine: EngineId;
  readonly prompt: string;
  /** A user-attached image, by name. The product does not thumbnail attachments
   *  on a historical user bubble (uploads are a composer affordance), so this is
   *  rendered as an honest "attached" chip, and the composer tray is shown below. */
  readonly attachment?: string;
  readonly status: "completed" | "running" | "queued" | "failed";
  readonly live: boolean;
  readonly nodes: TimelineNode[];
  /** The settled answer markdown (drives the copy button). */
  readonly answer?: string;
  readonly queuePosition?: number;
};

const TURN1_ANSWER = `## Rate limiting is in place

Added a token-bucket limiter between auth and routing, keyed by \`orgId\` at
**100 req/min**, and wired the honest 429 path.

### What changed
- \`src/gateway/rate-limit.ts\` - new \`rateLimit()\` middleware (continuous refill).
- \`src/gateway/middleware.ts\` - inserted into the chain after \`authenticate\`.
- A drained bucket now returns \`429\` with a \`Retry-After\` header.

\`\`\`ts
chain = [authenticate, rateLimit({ perMinute: 100, keyBy: "orgId" }), routeRequest];
\`\`\`

| Case | Before | After |
| --- | --- | --- |
| Within limit | 200 | 200 |
| Over limit | 200 | 429 + Retry-After |
| Missing org | 500 | 401 |

Tests pass (\`bun test\`). Next I can add the load-test evidence and open a PR.`;

const TURN2_ANSWER = `## PR opened with load-test evidence

Opened **skynet/gateway#128** and attached the k6 run. Under a 5x burst the
limiter held the org to its budget and the p99 stayed flat.

| Metric | Baseline | Under limiter |
| --- | --- | --- |
| Throttled | 0% | 41% |
| p99 latency | 84ms | 86ms |
| 5xx | 0 | 0 |

A short staging walkthrough recording and the PDF summary are attached below.`;

export const conversation: SampleTurn[] = [
  {
    id: "turn-1",
    engine: "opencode",
    prompt:
      "Add token-bucket rate limiting to the API gateway - 100 req/min per org, and return a proper 429 with Retry-After. I attached the current error screenshot.",
    attachment: "current-429.png",
    status: "completed",
    live: false,
    answer: TURN1_ANSWER,
    nodes: [
      marker("m-skill", {
        kind: "skill",
        playbook: true,
        name: "Gateway deploy runbook",
        version: 7,
        hash: "d3adb33f",
      }),
      marker("m-ctx-mem", {
        kind: "context",
        source: "memory",
        itemCount: 3,
        query: "gateway middleware conventions",
      }),
      marker("m-ctx-kb", {
        kind: "context",
        source: "knowledge",
        itemCount: 5,
        query: "token bucket rate limiting",
      }),
      reasoning(
        "r-1",
        "The gateway already runs an ordered middleware chain in `src/gateway/`. A token bucket keyed by org id belongs right after authentication and before routing. Let me confirm the current order and how 429s are produced today before writing anything.",
      ),
      text("t-1", "I'll start by mapping the current middleware chain and the existing 429 path."),
      tool({
        kind: "command",
        label: "ls src/gateway",
        code: {
          tool: "bash",
          input: { command: "ls src/gateway" },
          output: "middleware.ts\nrouter.ts\ntypes.ts\n__tests__/",
          exit_code: 0,
          duration_ms: 180,
        },
      }),
      tool({
        kind: "command",
        label: "read middleware.ts",
        code: {
          tool: "read",
          input: { file_path: "src/gateway/middleware.ts" },
          output: "export const chain = [authenticate, routeRequest];",
        },
      }),
      text("t-2", "Found the chain. Searching for any existing limiter and the current 429 usage."),
      tool({
        kind: "command",
        label: "429 handling",
        chip: "search",
        code: { query: "429 Retry-After", tool: "grep" },
      }),
      tool({
        kind: "command",
        label: "grep -rn 'RateLimit' src",
        code: {
          tool: "bash",
          input: { command: "grep -rn 'RateLimit' src" },
          output: "",
          exit_code: 1,
          duration_ms: 90,
        },
      }),
      tool({
        kind: "command",
        label: "token bucket vs sliding window",
        code: {
          tool: "websearch",
          input: { query: "token bucket vs sliding window rate limiting node" },
          output: "Token bucket allows short bursts while capping the sustained rate...",
        },
      }),
      tool({
        kind: "command",
        label: "fetch RFC 6585",
        code: {
          tool: "webfetch",
          input: { url: "https://httpwg.org/specs/rfc6585.html" },
          output: "429 Too Many Requests - the user has sent too many requests in a given amount of time...",
        },
      }),
      tool({
        kind: "command",
        label: "search knowledge base",
        code: {
          tool: "mcp__knowledge__search_knowledge",
          input: { query: "org rate limit conventions", description: "org rate limit conventions" },
          output: "3 matching runbooks - all key limiters by org id and expose Retry-After.",
        },
      }),
      text("t-3", "Order and conventions confirmed. Implementing the limiter and wiring it in."),
      tool({
        kind: "file",
        label: "write rate-limit.ts",
        code: {
          tool: "write",
          input: { file_path: "src/gateway/rate-limit.ts", content: RATE_LIMIT_FILE },
        },
      }),
      tool({
        kind: "file",
        label: "edit middleware.ts",
        code: {
          tool: "edit",
          input: {
            file_path: "src/gateway/middleware.ts",
            old_string: MIDDLEWARE_OLD,
            new_string: MIDDLEWARE_NEW,
          },
          output: "Applied 1 edit.",
        },
      }),
      tool({
        kind: "command",
        label: "bun test src/gateway",
        code: {
          tool: "bash",
          input: { command: "bun test src/gateway" },
          output: "✓ routes an authed request\n✓ returns 429 + Retry-After past the org limit\n\n 2 pass  0 fail",
          exit_code: 0,
          duration_ms: 2400,
        },
      }),
      {
        kind: "file",
        key: "f-rate-limit",
        file: {
          path: "src/gateway/rate-limit.ts",
          changeType: "create",
          diff: {
            artifactId: "artifact-diff-rl",
            bytes: 1268,
            sha256: "b".repeat(64),
            contentType: "text/x-diff",
          },
        },
      },
      marker("m-mem-write", {
        kind: "memory",
        op: "remember",
        scope: "org",
        failed: false,
        reconciled: false,
      }),
      text("t-answer-1", TURN1_ANSWER),
      {
        kind: "artifact",
        key: "a-diagram",
        artifact: {
          id: "artifact-diagram",
          name: "rate-limit-diagram.png",
          bytes: 48213,
          sha256: "c".repeat(64),
          contentType: "image/png",
        },
      },
    ],
  },
  {
    id: "turn-2",
    engine: "opencode",
    prompt: "Nice. Now run the load test, open a PR, and attach the evidence.",
    status: "completed",
    live: false,
    answer: TURN2_ANSWER,
    nodes: [
      reasoning(
        "r-2",
        "I'll fan out a subagent to run the k6 load test so I can keep drafting the PR body in parallel, then attach both the recording and the summary.",
      ),
      tool({
        kind: "task",
        label: "Subagent - k6 load test",
        chip: "subagent",
        code: {
          tool: "task",
          input: {
            description: "Run the k6 load test at 5x burst",
            prompt: "Run scripts/loadtest/rate-limit.js at 5x burst and report throttle rate + p99.",
          },
        },
      }),
      tool({
        kind: "command",
        label: "computer.screenshot",
        code: {
          tool: "computer",
          input: { action: "screenshot", description: "staging dashboard" },
          output: "Captured 1440x900 screenshot of the staging latency dashboard.",
        },
      }),
      tool({
        kind: "command",
        label: "open pull request",
        code: {
          tool: "mcp__github__create_pull_request",
          server: "github",
          input: {
            title: "gateway: token-bucket rate limiting (100/min per org)",
            description: "skynet/gateway#128",
          },
          output: "Opened PR #128 - gateway: token-bucket rate limiting.",
        },
      }),
      text("t-answer-2", TURN2_ANSWER),
      {
        kind: "artifact",
        key: "a-shot",
        artifact: {
          id: "artifact-screenshot",
          name: "staging-latency.png",
          bytes: 91422,
          sha256: "d".repeat(64),
          contentType: "image/png",
        },
      },
      {
        kind: "artifact",
        key: "a-recording",
        artifact: {
          id: "artifact-recording",
          name: "staging-walkthrough.webm",
          bytes: 5_204_880,
          sha256: "e".repeat(64),
          contentType: "video/webm",
        },
      },
      {
        kind: "artifact",
        key: "a-delivered",
        artifact: {
          id: "artifact-pdf",
          name: "rate-limit-report.pdf",
          bytes: 187_004,
          sha256: "f".repeat(64),
          contentType: "application/pdf",
          destination: "slack",
        },
      },
    ],
  },
  {
    id: "turn-3",
    engine: "opencode",
    prompt: "Deploy the change to staging.",
    status: "running",
    live: true,
    nodes: [
      marker("m-reconciling", { kind: "reconciling", deadlineMs: 9000 }),
      tool({
        kind: "task",
        label: "Starting sandbox",
        chip: "opencode",
        code: {},
      }),
      reasoning(
        "r-3",
        "Applying the manifests to the staging cluster and watching the rollout.",
      ),
      tool({
        kind: "command",
        label: "kubectl apply -f k8s/staging",
        code: {
          tool: "bash",
          input: { command: "kubectl apply -f k8s/staging && kubectl rollout status deploy/gateway" },
        },
      }),
    ],
  },
  {
    id: "turn-4",
    engine: "opencode",
    prompt: "After staging is green, bump the changelog and tag v2.4.0.",
    status: "queued",
    live: false,
    queuePosition: 1,
    nodes: [],
  },
];

// ── Adjacent-surface fixtures (session chrome + rails, not timeline events) ───

/** Mixed-state plan, fed to the real ToolStepRow todowrite path (the plan card as
 *  it renders in the Agents/subagent activity surface). */
export const planTodoStep: ApiStep = sampleStep({
  kind: "command",
  label: "todowrite",
  code: {
    tool: "todowrite",
    input: {
      todos: [
        { content: "Map the gateway middleware chain", status: "completed" },
        { content: "Implement the token-bucket limiter", status: "completed" },
        { content: "Wire 429 + Retry-After and cover with a test", status: "in_progress" },
        { content: "Open the PR with load-test evidence", status: "pending" },
        { content: "Roll a bespoke Redis limiter", status: "cancelled" },
      ],
    },
  },
});

/** The same mixed states as canonical plan entries (for a direct PlanChecklist). */
export const planEntries: readonly PlanEntry[] = [
  { id: "p1", text: "Map the gateway middleware chain", status: "completed" },
  { id: "p2", text: "Implement the token-bucket limiter", status: "completed" },
  { id: "p3", text: "Wire 429 + Retry-After and cover with a test", status: "in_progress" },
  { id: "p4", text: "Open the PR with load-test evidence", status: "pending" },
  { id: "p5", text: "Roll a bespoke Redis limiter", status: "cancelled" },
];

export const PROPOSED_PLAN_MARKDOWN = `# Rate limiting rollout

## Summary
Ship a token-bucket limiter to the gateway, then roll it to staging and prod
behind a flag.

## Steps
1. Add \`rateLimit()\` middleware keyed by org id.
2. Insert it after authentication in the chain.
3. Return \`429\` with \`Retry-After\` on a drained bucket.
4. Cover the limit + header with a gateway test.
5. Load-test at 5x burst and attach the evidence to the PR.
6. Roll to staging behind \`gateway.rateLimit\`, watch p99, then enable in prod.

## Risks
- A shared in-memory bucket does not span replicas; a Redis-backed bucket is the
  follow-up once the single-replica behavior is validated.`;

/** Three child-agent rows spanning live / settled / failed states. */
export const agentRows: readonly AgentPanelRowModel[] = [
  {
    title: "Load-test runner",
    role: "loadtest",
    model: "claude-sonnet-5",
    status: "running",
    statusLabel: "Running",
    progress: "k6: 5x burst, 41% throttled so far",
    lastToolName: "bash",
    lastStepLabel: "run k6 scenario",
    result: null,
    usage: { totalTokens: 18_400, toolUses: 12 },
    elapsed: "48s",
  },
  {
    title: "Docs writer",
    role: "docs",
    model: "claude-haiku-4-5",
    status: "completed",
    statusLabel: "Completed",
    progress: null,
    lastToolName: "write",
    lastStepLabel: "write rate-limits.md",
    result: "Wrote docs/api/rate-limits.md and linked it from the gateway README.",
    usage: { totalTokens: 7_950, toolUses: 5 },
    elapsed: "1m 12s",
  },
  {
    title: "Redis limiter spike",
    role: "spike",
    model: "openai/gpt-5.6-sol",
    status: "failed",
    statusLabel: "Failed",
    progress: null,
    lastToolName: "bash",
    lastStepLabel: "bun test",
    result: "Aborted: no Redis in the sandbox; deferred to the follow-up.",
    usage: { totalTokens: 22_100, toolUses: 9 },
    elapsed: "34s",
  },
];

/** Composer upload tray state: a ready image, one uploading, one failed. */
export const sampleUploads = [
  { localId: "u1", id: "up-1", name: "current-429.png", sizeBytes: 48_120, status: "ready" as const },
  { localId: "u2", id: null, name: "har-capture.json", sizeBytes: 210_400, status: "uploading" as const },
  { localId: "u3", id: null, name: "trace.zip", sizeBytes: 1_400_000, status: "error" as const },
];

export const THREAD_ERROR_SUMMARY =
  "Run failed: the staging cluster rejected the manifest (ImagePullBackOff on gateway:2.4.0).";

export const USER_STOP_SUMMARY = "Stopped by user";
