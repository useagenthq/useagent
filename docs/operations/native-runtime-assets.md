# Native runtime assets

The backend image carries one immutable native runtime archive for sandbox
providers that do not have the runtime preinstalled. The archive is a release
asset, not committed to Git.

`backend/runtime-assets/manifest.json` pins the release filename, archive hash,
embedded checksum-manifest hash, source commit, dependency version, and frozen
Bun dependency-lock hash. The archive is built from reviewed fork commit
`42ef3397fa38befec011b840c953adbff7c8770a`, based on upstream nightly
`v0.1.1-nightly.20261018.3315` (`9c161462c94f7d9d6d9169da5c841457cbadf213`) plus a fork
commit that sets the version, on the V2 orchestrator line. It is the server's `dist`
directory with its bundled web client, plus a `T3_SOURCE_COMMIT` marker and a
`SHA256SUMS` manifest of every file. Artifact identity is not live
engine/provider certification.

## Layout in a sandbox

The server bundle inlines its JavaScript dependencies and leaves only native
packages external: `@ff-labs/fff-node`, `node-pty` and `@napi-rs/keyring`. The
fork drops upstream's Cursor driver, whose `@cursor/sdk` closure would otherwise
be required at load. `undici` stays external too, but the runtime loads it only on
Node 26 or later (to keep fetch off HTTP/2); the sandbox images run Node 24.19.0, so the
closure leaves it out, and an image that moves to Node 26 needs it in the closure first.
The upstream npm package is now a launcher for prebuilt
single executables, so it is not installed. The runtime root holds:

- `node_modules/`: the frozen closure from `backend/runtime-assets/dependencies/`
  (`package.json` plus `bun.lock`, installed with `bun install --frozen-lockfile`;
  `node-pty` is built with the sandbox's Node toolchain),
- `dist/`: the verified fork archive, resolving its externals from the
  neighbouring `node_modules`,
- `bin/t3`: a launcher that runs `node dist/bin.mjs`; installation checks it
  prints `t3 v<dependencyVersion>`.

The dependency `package.json` carries the runtime release it was frozen for as
its own `version`, and the stage script checks it against the manifest. The
dependency directory's `node_modules` stays ignored and is never packaged.

Reuse probes detect damaged files, launchers, and dependency symlinks. They are
corruption/reproducibility checks, not remote attestation against tenant code
with full access to a sandbox's tools and process environment. Credential
isolation remains the separate responsibility of the trusted control plane.

The first access to a sandbox's runtime runs the artifact probe once per
sandbox and runtime generation. A pass is recorded in Postgres
(`runtime_artifact_verifications`), so a restarted backend skips the probe for
that sandbox, as the process that ran it does.

## Staging

```sh
bun run deploy/stage-native-runtime.ts /path/to/native-runtime-42ef3397fa38.tar.gz
```

Without an argument, the script downloads the exact filename from the public
`useagenthq/useagent` release `native-runtime-<first 12 of sourceCommit>` with
the `gh` CLI, so checkouts without a credential stage the same bytes. It
verifies the outer archive hash, embedded source marker, embedded `SHA256SUMS`
hash, tracked dependency lock and dependency version before atomically placing
the ignored archive under `backend/runtime-assets/`.

The backend Docker build carries the staged archive under
`/app/backend/runtime-assets/`, exposes stable links from
`/opt/useagent/native-runtime/`, and repeats the verification. Missing or
changed bytes fail the image build. CI stages the same release asset before
every backend image build.

## Publishing a replacement

Build a new uniquely named archive and manifest. Never overwrite a release asset
or reuse an archive filename for different bytes. Publish the archive and the
fork patch on a new public `native-runtime-<sha12>` release, and the archive,
bundle and patch on a new private release. A runtime distribution change does
not change harness protocol selection: Codex, Claude Code, OpenCode, and Pi
remain on their native engine drivers.

The matching `t3code-fork-42ef3397fa38.bundle` and `.patch` preserve the custom
source; their hashes and upstream prerequisite commit are recorded in
`third_party/t3code-fork.lock`. Fetch the upstream prerequisite before using
the Git bundle. The fork's contract label (`orchestrator-v2-hosted-codex-host-switches-v7`)
is separate from byte identity.

## Runtime state on retained sandboxes

The V2 runtime keeps its state in `userdata/statev2.sqlite`. On first boot it would
import a V1 `state.sqlite` with only thread shells and a transcript excerpt, and a
V1 runtime cannot read the V2 database. So the launch refuses to start when
`userdata/state.sqlite` exists: a V1 sandbox is recreated, never migrated. The
switch to V2 is fix-forward; there is no path back to a V1 runtime. The image
carries no runtime state.

## History

- `v0.0.4` (2026-09): fork `90dc3ebbb74b` on upstream
  `v0.0.39-nightly.20260906.1293`, installed by overlaying the fork's `dist` on
  the registry `t3` package.
- 2026-10-03: fork `762f4b14b328` on upstream `v0.0.45`; the fork `dist` sits
  beside a three-package native closure, `fff-node` is imported statically, and
  thread reads use a two-turn window.
- 2026-10-03: fork `dd2b1389590f` on upstream nightly
  `v0.0.46-nightly.20261003.2632` (orchestrator V2) for the V2 lane: hosted
  Codex over the relay, host switches for the runtime's MCP, continuations and
  instructions, Cursor dropped, a 20 s OpenCode 2 model-load wait. Engines:
  Claude Code 2.1.285 and `@opencode/cli` 2.0.18.
- 2026-10-11: forks `68863eaf53be` and `b8229bffd8ef` on the same nightly: an answer that never
  reaches its provider stops the run with that reason, Claude's refusal fallback
  dialog is answered, and Codex asks native questions in Manual mode only.
- 2026-10-11: fork `e23fb6e2e7ec`: a Codex server request whose handler dies is
  answered with a JSON-RPC error instead of left waiting.
- 2026-10-11: fork `2fab68e06737` rebased onto upstream nightly
  `v0.0.46-nightly.20261011.2967` (699 upstream commits newer; providers moved into
  packages, `fff-node` 0.11.0 in the native closure). A hosted Codex session ends
  when its relay socket closes or its instance is replaced, so a follow-up after the
  host pauses an idle sandbox opens a fresh session; native Codex goals stay off when
  the host owns every run.
- 2026-10-11: fork `db6f1a52b92b` rebased onto upstream `main` `ed0f7b908b` (the
  Sol Ultrafast model picker fix, pull request review guides); the Codex client
  schema is regenerated from Codex 0.162.1, a notification it cannot decode is
  logged, and a partial answer streams like commentary. Engines: Codex 0.162.1, Claude Code 2.1.296 and `@opencode/cli` 2.0.26.
- 2026-10-16: fork `be5e6f862275` rebased onto upstream release `v0.1.0` (302
  upstream commits past `ed0f7b908b`, with upstream's "prepare v0.1.0" version commit
  and its test fix under the fork's commits), so the runtime reports `t3 v0.1.0`. Since
  v0.1.0 the runtime continues interrupted threads after a restart by default; the
  launch's settings pin keeps that off, and the fork makes restart continuation obey
  `T3_PROVIDER_CONTINUATIONS=off` whatever a project override says; with the switch off
  the runtime's scheduler runs no due work either. Engines unchanged.
- 2026-10-17: fork `3f0f578f2b53` on the same base: after a sandbox pause OpenCode's MCP
  servers are re-dialed, and the next prompt waits until they are back. Engines unchanged.
- 2026-10-17: forks `a72f0dfb8a6e` and `23456795847f` on top of it: command items carry their
  output (whole up to 16 KiB) and Claude's exit codes, and a Codex file change lists every file
  of its patch. Engines unchanged.
- 2026-10-19: fork `7a5654cc7499` rebased onto upstream nightly
  `v0.1.1-nightly.20261018.3315` (499 upstream commits past v0.1.0); upstream's v0.1.0
  release commits leave the fork (main has them) and a fork commit reports the nightly's
  version. Engines unchanged.
- 2026-10-19: fork `42ef3397fa38` on top of it: with continuations off the runtime refuses at
  dispatch any message a person did not send, and OpenCode steers wait behind the freeze gate.
  Engines unchanged.
