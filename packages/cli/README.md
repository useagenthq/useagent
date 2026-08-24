# @useagent/cli (`useagent`)

Fan monotonous tasks out to your hosted useAgent org from a local machine, in
parallel, and collect verified results. A local agent (Claude Code etc.) drives the
cloud fleet through the bundled MCP server; a human drives it through the CLI.

Every task becomes a normal cloud run in your org's event ledger. Each run can pick its
own engine and model. Optional QC posts a verifier reply in the same thread and records
a `VERDICT: PASS|FAIL` next to the work it judges.

## Install

Runtime is [Bun](https://bun.sh). Once published:

```
bunx @useagent/cli --help
```

Inside this repo (unpublished), run the bin directly:

```
bun packages/cli/src/bin.ts --help
```

## Configuration

| Variable            | Required | Default                     |
| ------------------- | -------- | --------------------------- |
| `USEAGENT_API_KEY`  | yes      | -                           |
| `USEAGENT_BASE_URL` | no       | `https://skynet.meow.gs`    |

The key is sent verbatim as `Authorization: Bearer <key>` on every request.

## Commands

### `useagent run "<prompt>"`

Dispatch one task; print the run id and its web URL.

```
useagent run "summarize the release notes" --engine codex --repo acme/web
useagent run "reply with exactly OK" --watch
```

Flags: `--engine <id>`, `--model <id>`, `--repo owner/name` (repeatable), `--watch`
(poll and stream status lines, then print the final answer).

### `useagent fan <tasks.jsonl>`

One JSON object per line: `{ "prompt": "...", "engine": "...", "model": "...", "repos": ["owner/name"] }`
(`prompt` required, the rest optional). Dispatches with bounded concurrency, waits for
each run to settle, optionally verifies, and writes one result object per line.

```
useagent fan tasks.jsonl --parallel 6 --qc "Did it fully answer? Emit VERDICT: PASS or VERDICT: FAIL." --out results.jsonl
```

Each result line: `{ runId, status, verdict?, answer, url }` (plus `prompt`, and `error`
on a dispatch failure). A summary table prints to stderr; the JSONL goes to `--out` (or
stdout when omitted).

### `useagent status <runId>`

One-shot current status + answer for a run.

### `useagent mcp`

Start a stdio MCP server exposing the fleet to a local agent. Tools:

- `dispatch_task` - dispatch one task, return the run id immediately.
- `dispatch_parallel` - dispatch many (bounded concurrency), return run ids immediately.
- `get_run_result` - settle-aware collect; pass `qc` to also run an in-thread verifier.
- `list_recent_runs` - recent runs for the org.

Register it with Claude Code:

```
claude mcp add useagent-fleet -- bunx @useagent/cli mcp
```

(Set `USEAGENT_API_KEY` in the environment Claude Code launches the server with.)

## Latency

Claiming a warm-pool sandbox is typically seconds; a cold start can be tens of seconds.
`fan` and `get_run_result` poll until each run settles, so budget accordingly for large
batches. Live end-to-end use needs a real `USEAGENT_API_KEY` (org API keys ship
separately).
