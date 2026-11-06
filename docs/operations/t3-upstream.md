# T3 upstream tracking

UseAgent runs a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) inside every
sandbox as the agent runtime. This file is the log of which upstream version we run, what our fork
changes, and how to take the next upstream release. Update the log table on every runtime change.

## What we run now

| Item | Value |
|---|---|
| Upstream base | nightly `v0.1.1-nightly.20261018.3315` (`9c161462c9`, on upstream main), with a fork commit that reports that version (orchestrator V2) |
| Fork head | `42ef3397fa38` (branch `useagent-v2`; bundle and patch attached to the release) |
| Runtime release | `native-runtime-42ef3397fa38` (pro and public `useagenthq/useagent`) |
| Pins in `third_party/t3code-fork.lock` and `backend/runtime-assets/manifest.json` | contract `orchestrator-v2-hosted-codex-host-switches-v7` |
| Engines | Codex `0.162.1`, Claude Code `2.1.296`, OpenCode `@opencode/cli 2.0.26` (installed with `--trust`), Pi (bypasses T3) |
| Runtime generation | `useagent-runtime-v9`, the image default (compose blanks any host env pin, so each image brings its own) |

## What our fork changes

Every item is a commit on `useagent-v2`. Re-port each one when rebasing; upstream rewrites often
move the code they touch.

1. Cursor driver removed from the built-in, V2 adapter and usage driver lists and from the adapter
   infrastructure (its SDK requires `@cursor/sdk` at load; the Cursor usage-account layers stay, they
   never load it; the Cursor usage tests are skipped); `fff-node` imported statically.
2. `T3_PROVIDER_MCP=off`: sessions start with `configureMcp: false`, so agents never get T3's own
   thread tools (create threads, schedules, forks) that would bypass our backend.
3. `T3_PROVIDER_CONTINUATIONS=off`: T3 never starts a run by itself (background-job wakes,
   continuations), including the restart continuation v0.1.0 turned on by default (it
   obeys the switch even when a project override says continue) and the scheduler's due work
   (scheduled tasks, usage-limit resumes) and parses no native Codex `/goal`; every run goes through our admission and
   spend checks. At dispatch, the runtime also refuses any message a person did not send (pull
   request watch wakes, delegated questions and completions, an agent's request through T3's
   own tools), whatever path made it. The host also turns Codex's `goals` feature off on every
   Codex it configures.
4. `T3_PROVIDER_INSTRUCTIONS=off`: no "you are running in T3 Code" or PR-linking text in agent
   instructions; our backend writes the preamble.
5. Hosted Codex through our relay: WebSocket transport in `CodexAppServerClientFactory.open`, no
   `config` on hosted thread calls, turn environments on `turn/start` (the client schema carries
   them), required-MCP wait on a thread's first turn only. A hosted session ends when its relay
   socket closes or the host replaces the instance that named its relay URL, so the session manager
   releases it and the next turn dials again. Because hosted thread calls carry no `config`,
   upstream's 10 s MCP startup grace (v0.1.0) is not sent; the required-MCP wait covers the gateway.
6. OpenCode 2 model loader waits up to 20 s for a cold catalog (upstream gave up after 5 s).
7. Version string: upstream stamps a nightly's version only when it publishes it, so the tree
   still says 0.1.0; the fork's last commit sets `0.1.1-nightly.20261018.3315`, so the runtime
   reports `t3 v0.1.1-nightly.20261018.3315` and its npx hints keep `@nightly`.
8. Telemetry: `T3CODE_TELEMETRY_ENABLED=false` is set by our launch env, not a fork change.
9. Self-started continuations after a restart: v0.1.0 turns `continueThreadsAfterServerUpdate` on
   by default; our launch pins it (and `autoResumeLimitedThreads`) off in `settings.json` before
   every start, not a fork change.
10. After a freeze (a paused sandbox: the wall clock runs more than 1 s past the monotonic one
    between samples), no OpenCode prompt or command goes out until every MCP server that was
    connected or reconnecting has reconnected since the latest freeze and reports connected:
    the turn re-dials them and waits, at most 15 s per check, before the turn and again right
    before sending, and sets aside a server list read across another freeze. What is owed is
    kept with the OpenCode process, so a session that replaces another still owes it. A turn
    that runs out of time fails with a clear message, and the next turn dials again any server
    still owed.
    OpenCode otherwise re-dials lazily and the first prompt can miss the gateway's tools. One
    gate in the adapter stands in front of every model-bound send (the turn's prompt or command,
    a steer, the note a declined permission steers in). A steer cannot fail its turn the way a
    prompt can, so it waits behind the gate and goes out anyway once the gate gives up; the note
    waits as long at most, and the answer it comes with goes out either way.
11. Command items carry their output on the wire whole up to 16 KiB and none of a longer one
    (`outputOmitted`), never a piece: the plane keeps it only in the item's bounded record,
    redacted whole before it is cut (`runtime-v2-view.ts`). Claude Bash items carry the exit
    code Claude Code reports, and an item's exit code, not words in its output, decides whether
    the wire marks it failed.
12. A Codex file change item lists every file of its patch in `changes` (operation and path, a
    move's old path as `oldPath`); `fileName` and `diffStr` stay the first file's, which is what
    the plane reads.

The relay still fills in the run's environment when a turn arrives without one
(`codex-subscription-protocol.ts`), and answers the runtime's known thread methods it does not carry
(forks, reverts, goals, context injection) with an error instead of ending the session.

## What our backend depends on (the wire)

The driver translates V2 at one edge (`backend/src/engines/runtime-v2-view.ts`) into the shapes the
rest of the backend and the frontend already use. It speaks:

- WebSocket RPC with `?orchestrationProtocol=2`: `orchestration.subscribeThread`,
  `orchestration.dispatchCommand` (`message.dispatch`, `run.interrupt`, `runtime-request.respond`,
  `provider-session.detach`), `server.refreshProviders`.
- HTTP: `/.well-known/t3/environment` (protocol check, fails closed unless 2),
  `/threads/:id/bounded` with header `x-t3-orchestration-protocol: 2`, `/api/projects/mutate`.

Upstream changes to these are the ones that break us. Watch `apps/server` orchestration contracts,
`CodexAdapterV2` and the app-server client, the OpenCode and Claude adapters,
`ProviderSessionManager` (`configureMcp`), `ProviderContinuationRequests`, `buildRuntimeInstructions`
and the model manifest.

## Taking a new upstream release

1. Fetch upstream, rebase `useagent-v2` onto the chosen ref, re-port the fork items above. Take a
   nightly tag (cut from main): preview tags carry unmerged feature branches.
2. Run the fork's server suite and typecheck; failures that also fail on clean upstream are environmental.
3. Package with `deploy/t3/package-runtime.sh <fork checkout> <outdir>`; make the patch
   (`git diff <base> HEAD`) and bundle (`git bundle create ... <base>..useagent-v2`).
4. Scan the archive and patch for secrets, internal hosts and personal data; publish a new
   `native-runtime-<sha12>` release on pro (archive, bundle, patch) and public (archive, patch).
   Never overwrite an asset; never mark it latest.
5. Point `backend/runtime-assets/manifest.json`, `third_party/t3code-fork.lock`, the Dockerfile
   checks and the engine pins at the release; run the backend suite.
6. Merge to main (auto-deploys), bake the sandbox image from the promoted backend image
   (`deploy/hetzner/bake-native-images.sh`), build the E2B template under its unique image tag
   (E2B reuses its cache when a tag is reused), set `CUBE_TEMPLATE_ID` and
   `RUNTIME_CUBE_TEMPLATE_ID` in both `backend.env` and `gateway.env`, bump the code default
   `DEFAULT_RUNTIME_GENERATION` in `runtime-environment.ts` when the wire changes (compose ignores
   the host env value), and recreate backend and gateway.
7. Smoke one turn per engine (Codex subscription, Codex key, Claude, OpenCode). Fix forward.

## Log

| Date | Upstream | Fork | Release | Template | Notes |
|---|---|---|---|---|---|
| 2026-10-03 | v0.0.45 | `762f4b14b328` | `native-runtime-762f4b14b328` | `6kkpyffstib7km2vrwjt` | last pre-V2 runtime; telemetry off; Chromium locked down |
| 2026-10-04 | nightly 20261003.2632 (`f391794a35`) | `dd2b1389590f` | `native-runtime-dd2b1389590f` | `3y8my0mv4fmnr4tkaq2k` | orchestrator V2 switch: WebSocket commands, native subagents, OpenCode 2, Claude 2.1.285 |
| 2026-10-11 | nightly 20261003.2632 (`f391794a35`) | `68863eaf53be` | `native-runtime-68863eaf53be` | see host env | first engine request fixes |
| 2026-10-11 | nightly 20261003.2632 (`f391794a35`) | `b8229bffd8ef` | `native-runtime-b8229bffd8ef` | `6t74inbj2dlwnvfyldym` | engine request audit: undelivered answers stop the run, Claude refusal fallback dialog, Codex questions in Manual mode only |
| 2026-10-11 | nightly 20261003.2632 (`f391794a35`) | `e23fb6e2e7ec` | `native-runtime-e23fb6e2e7ec` | see host env | every Codex server request is answered, even when its handler dies |
| 2026-10-11 | nightly 20261011.2967 (`8d199b4f7b`) | `2fab68e06737` | `native-runtime-2fab68e06737` | see host env | rebased 699 upstream commits; hosted Codex sessions end with their relay socket or instance (follow-ups after a sandbox pause failed with read-input-stream); no native goals |
| 2026-10-11 | `main` (`ed0f7b908b`) | `db6f1a52b92b` | `native-runtime-db6f1a52b92b` | see host env | 3 upstream commits (Sol Ultrafast picker fix, review guides); Codex client schema from 0.162.1; Codex 0.162.1, Claude Code 2.1.296, OpenCode 2.0.26 |
| 2026-10-16 | v0.1.0 (`81493efb71`) | `be5e6f862275` | `native-runtime-be5e6f862275` | `1stzyy97pksjfri1qwak` | 302 upstream commits (provider stream end without a terminal fails the run, ACP malformed update, slow Codex MCP grace, Claude plugin MCP cleanup, HTTP/2 crash, approvals, SQLite and event-loop perf); engines unchanged; restart continuation and scheduled due work obey `T3_PROVIDER_CONTINUATIONS=off` |
| 2026-10-17 | v0.1.0 (`81493efb71`) | `3f0f578f2b53` | `native-runtime-3f0f578f2b53` | `acae9a8asb7lsldl25r9` | OpenCode re-dials its MCP servers after a sandbox pause before the next prompt; command output on the wire unchanged |
| 2026-10-17 | v0.1.0 (`81493efb71`) | `a72f0dfb8a6e` | `native-runtime-a72f0dfb8a6e` | `wbgco2utj7nd5ukcdkli` | command output on the wire (whole up to 16 KiB) and Claude exit codes, on top of `3f0f578f2b53` |
| 2026-10-17 | v0.1.0 (`81493efb71`) | `23456795847f` | `native-runtime-23456795847f` | `z4l5cmr17dkj74ujxvh9` | a Codex file change lists every file of its patch (`changes`), on top of `a72f0dfb8a6e` |
| 2026-10-19 | nightly 20261018.3315 (`9c161462c9`) | `7a5654cc7499` | `native-runtime-7a5654cc7499` | `e69y4jc119uv2tlpryt9` | 499 upstream commits (live command output on its own RPC, which the plane does not use; restart wakes for subagents' cut background work; follow-ups queued while a thread compacts; one resolver for project and worktree folders; Claude subagent fixes); our 22 commits carried, upstream's two v0.1.0 release-branch commits left out (main has them); engines unchanged |
| 2026-10-19 | nightly 20261018.3315 (`9c161462c9`) | `42ef3397fa38` | `native-runtime-42ef3397fa38` | `ofm96owqkopgr9uzp5e5` | follow-up on `7a5654cc7499`: with continuations off the runtime refuses at dispatch any message a person did not send, and OpenCode steers wait behind the freeze gate (then go out, never dropped); reviewed by gpt-5.6-sol (astra out of quota) |
