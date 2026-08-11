# TTFT model-route benchmark

Opt-in perf harness (task #194, Perf Phase 4.4). It measures streaming latency of
the curated model routes so we can compare time-to-first-token and token
throughput across providers. It is **not** part of the test suite - the filename
does not match bun's test glob, so `bun test` never runs it.

## Run

```sh
cd backend
bun test/perf/ttft-bench.ts               # 5 samples per route per class
bun test/perf/ttft-bench.ts --samples 2   # quick pass
bun test/perf/ttft-bench.ts --route opus  # only routes whose id contains "opus"
```

Keys come from the environment (bun auto-loads `backend/.env`). Read var names,
never values: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`.

## Routes

Curated model ids come from `src/runs/model-policy.ts`:

- **opencode-default** - Kimi K3 via OpenRouter (`DEFAULT_OPENCODE_MODEL`)
- **openrouter/claude-opus-5**, **openrouter/claude-sonnet-5** - via OpenRouter
  (the `anthropic/` vendor prefix is required on OpenRouter, per `src/chat/stream.ts`)
- **anthropic-direct/claude-opus-5**, **anthropic-direct/claude-sonnet-5** - direct
  on the Anthropic Messages API, only when `ANTHROPIC_API_KEY` is set

Every request carries the **same** single tool schema (a `browser_navigate`-like
tool). Only the prompt changes between the two classes:

- **simple** - a plain one-liner, no tool use expected
- **tool** - instructs the model to call `browser_navigate`

## Metrics (per sample)

- **ttft** - request start to the first delta of any kind (content, thinking, or
  tool-call arguments)
- **firstText** - request start to the first *visible text* delta, distinct from
  thinking (`-` when none arrives, e.g. a pure tool-call turn)
- **firstThinking** - request start to the first thinking/reasoning delta (null
  when the model streams none)
- **total** - request start to stream end
- **outputTokens / tokensPerSec** - from provider usage (null when unreported)
- **toolAttempted** - whether the model emitted a tool call

Reported as p50/p95 per route per class.

## Graceful degradation

- A route whose key is absent is **SKIPPED**.
- An OpenRouter 403 "Key limit exceeded" (daily cap) or 429 is marked **SKIP**,
  not a failure - the route stops sampling immediately.
- Every request has a 60s timeout; one route failing never aborts the run.

## Output

- Aligned table to stdout.
- Raw JSON to `results/ttft-<unix>.json` (git-ignored via `.gitignore` here).
  Only timings, model ids, and coarse error classes are recorded - never prompts,
  response bodies, or key material.
