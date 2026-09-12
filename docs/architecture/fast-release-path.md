# Fast release path - the image is the artifact; promote in minutes, certify in the background

Status: design, 2026-09-01. Replaces the shape of `deploy/hetzner/deploy-release.sh`
+ `release-gate.sh` (17 synchronous steps). Nothing here changes the trust
boundary or the single-backend-per-database rule.

## What actually happened today (measured on the host)

- One clean attempt of the gate is **15-20 minutes**. Today took **4.5 hours**
  because there were **9-10 attempts**: each failure (a bad probe, a loop bug, an
  SSH timeout while copying evidence) triggered a full rollback, a fix, exact-main
  CI, and a rerun from zero.
- Per attempt: snapshot + rsync + `bun install` + Next build **on the prod host**
  + restart, ~2 min. Seven parity canaries run **serially**
  (`PARITY_CONCURRENCY=1`), 35-60 s each, ~4 min. Then claude cutover / approval /
  question / cancel canaries, pi, the 4-harness product-child canary (~8 min),
  promotion restart, two post-promotion canaries.
- Admission is closed **before step 1/17 and stays closed through 15/17**. The
  candidate is already serving after 2/17. So production refused new runs for
  ~12-15 minutes on every one of the ~10 attempts.
- Most failures were in probes and gate plumbing, not the product. The gate
  rolled back a healthy candidate to fix its own tooling.

## The pattern the industry converged on

1. **Deploy is not release.** Ship dark behind flags; turn features on after
   promotion. We already have the flags (`PRODUCT_CHILD_THREADS`,
   `EXECUTION_GRAPH_ROLLOUT`, ...). Gating the *deploy* on every feature canary
   is the expensive inversion of this.
2. **Immutable artifact built once in CI**, host only downloads and swaps.
   Single-host zero-downtime is a solved problem (Kamal: build image, health
   check, switch proxy, keep the previous release on disk; rollback is a pointer
   flip, ~10 s).
3. **Small canary, short evaluation, then promote** (Google SRE). Our gate is
   not a canary - it is a full pre-production matrix on the only production
   host.
4. **Speed and stability reinforce each other** (DORA): elite teams deploy on
   demand and recover in minutes. The design goal is *fast, cheap recovery*, not
   a gate that tries to prove zero regressions before anything moves.
5. **Certify continuously, asynchronously, on a budget.** Live provider
   behaviour (resume, model switch, approvals, fan-out) is monitored by
   scheduled synthetic runs against the promoted release, with alerting and a
   one-command rollback - not replayed on every promotion.

## Vendor-agnostic by construction

This product is self-hosted by other people on Docker, Kubernetes, and random
VPSes; Hetzner is only where *we* run it. So the release unit is an **OCI
image per service**, built once in CI and pinned by digest. Every deployer is
a consumer of the same three images:

| Where | Deployer | Zero-downtime mechanism | Rollback |
|---|---|---|---|
| any VPS | `docker compose` (`compose.prod.yaml`, blue/green colors already designed) | start inactive color, wait healthy, flip proxy | re-point to previous color |
| Kubernetes | Helm chart (`charts/useagent`) | readiness probes; backend `Recreate` (one writer), others `RollingUpdate` | `helm rollback` |
| our Hetzner | the same compose path, driven by `deploy/promote` | same as VPS | same as VPS |
| PaaS | Fly / Railway / Render consume the image | platform rollout | platform rollback |

What already exists in the repo: `Dockerfile.backend` / `.frontend` /
`.gateway` (multi-stage, frontend standalone), `compose.prod.yaml`
(digest-pinned, `USEAGENT_RELEASE_COLOR` blue/green, per-color ports,
read-only, host network), `compose.local.yaml` (local build + pgvector
Postgres), health routes `GET /api/health` (backend) and `GET /healthz`
(frontend, reports release commit). What is missing: CI never builds the
images, no healthchecks in compose, gateway has no health route, the Kamal
file is an unwired scaffold, self-host still installs bun/node on the host,
and production still runs the 17-step bash gate on rsynced source.

## Target shape

```
CI (per main commit)        promote (critical path, <= 5 min)      certify (async)
------------------------    -----------------------------------    -----------------------
unit/integration/contract   pull manifest images by digest         scheduled synthetic runs:
build + push three OCI      migration check (expansion-safe)       parity matrix, approvals,
images for linux/amd64      drain <= 30 s, swap, restart           questions, cancel, pi,
upload digest manifest      three health routes + commit marker    product-child fan-out
                            provider-readiness (auth only)         budgeted per day
                            ONE cheap 1-turn run per engine        alert -> rollback command
```

Hard constraint: exactly one backend per database (boot recovery reconciles
other processes' in-flight runs). So the swap is drain -> stop -> start, with
admission closed for the swap window only (target <= 30 s). True overlap
(Kamal-style) needs lease-owner-aware recovery (slice 9); until then, 30 s.

Budgets: promote wall-clock <= 5 min; admission closed <= 30 s per promote;
rollback <= 60 s; a frontend-only change <= 3 min end to end.

## Slices (one PR each, in this order; each has a measured acceptance)

1. **CI images.** Add `.github/workflows/images.yml` using Buildx for all three
   root-context Dockerfiles on `linux/amd64`, with independent GHA layer caches.
   Pull requests build without publishing. `main` publishes
   `ghcr.io/useagenthq/{backend,gateway,frontend}` with `sha-<12>` and `main`
   tags, then uploads `release-manifest.json` containing the exact commit and
   three digest-pinned image references. Accept: all images build in CI in under
   10 minutes and the manifest contains immutable digests.
2. **Health and readiness.** Add `GET /health` to the gateway, health checks to
   both Compose files using the runtimes already inside the images, and a CI job
   that runs `docker compose -f compose.local.yaml up -d --wait` before probing
   all three routes. Accept: the local stack reaches healthy state in CI.
3. **Promote and rollback.** Implement one Bun command that consumes the release
   manifest, pulls by digest, warms the inactive frontend and gateway color,
   performs the single-backend `close -> drain <= 30 s -> stop -> start` swap,
   switches Caddy, reopens admission, proves health plus release identity, and
   records release history. Rollback flips to the previous manifest. Prove it
   first on a throwaway host from `infra/self-host/hetzner`, then destroy the
   host. Accept: promote <= 5 minutes, admission closed <= 30 seconds, rollback
   <= 60 seconds.
4. **Kubernetes.** Add `charts/useagent`: backend uses one replica with `Recreate`
   because it is the single database writer; frontend and gateway use
   `RollingUpdate`; all have probes, Services, Ingress, external-Postgres Secret,
   and manifest-supplied image values. Accept: Helm lint/template pass and the
   README quickstart renders on kind.
5. **Self-host Compose.** Add a pgvector-backed self-host Compose stack and a
   fresh-VPS guide; make `infra/self-host/deploy-app.sh` consume images rather
   than install Bun or Node on the host. Accept: fresh Ubuntu is healthy in under
   10 minutes by following the guide.
6. **Certification leaves promotion.** Run the existing live canaries every six
   hours and on demand with a daily paid-run budget, durable evidence, and a
   Slack alert containing the rollback command. Promotion keeps only health,
   migration expansion safety, auth readiness, and one cheap turn per engine.
   Provider availability failures alert instead of rolling back a healthy app.
   Accept: zero multi-turn paid canaries during promotion.
7. **Recorded provider fixtures.** Record and scrub real resume, model-switch,
   approval, and cancel sessions per engine, then replay them with recording
   disabled in CI. Fixtures contain no credentials, user data, host paths, or
   provider account identifiers. Accept: the parity matrix runs offline in under
   60 seconds.
8. **Delete the legacy gate.** Remove the old release, restart, source-sync, and
   applied one-off migration scripts plus their script-shaped tests. Keep the
   sandbox and Cube image bakes. Accept: `deploy/hetzner` contains fewer than 40
   files.
9. **Optional overlap.** Only after slices 1-8 are measured, add lease-owner-aware
   boot recovery so two backends may overlap briefly and admission need not
   close.

## Test discipline for this work

The deploy tree has ~150 files, most of them one test per shell script. New
slices add tests only for pure planner/classifier logic (manifest parsing,
color/port planning, and drain classification). No new test per shell step, no
new canaries, and no new legacy gate steps. Prefer deletion to another wrapper.
`deploy/hetzner` file count must go down, not up. Every PR reports before/after
numbers for: promote wall-clock, admission-closed seconds, rollback seconds,
and paid runs per promote.

## Prompt for the implementing agent

> Implement `docs/architecture/fast-release-path.md` slice by slice, one PR per
> slice, in order 1 -> 8. Do not touch production until slice 3 passes on a
> throwaway host and Abhishek explicitly authorizes promotion. Before slice 1,
> record the baseline from the host: promote wall-clock, admission-closed
> seconds, rollback seconds, paid canary runs per promote. Each PR must report
> the same four numbers after the change and meet the slice's acceptance line.
> Do not add canaries, gate steps, or a test per script; tests only for pure
> planner/classifier logic. The `deploy/hetzner` file count must not grow. Keep
> `REQUIRE_SINGLE_BACKEND=1` semantics: swap is drain -> stop -> start, admission
> closed for the swap window only. Commit with `gh@abhishek.it`; keep core
> release identifiers vendor-neutral.

## Sources

- Kamal (single host: build once, health check, proxy switch, rollback is a
  pointer flip): https://blog.saeloun.com/2026/07/23/rails-8-kamal-2-deployment-zero-downtime ,
  https://wolf-tech.io/blog/kamal-2-production-zero-downtime-deploys-secrets
- Google SRE Workbook, Canarying Releases: https://sre.google/workbook/canarying-releases/
- DORA / State of DevOps (throughput and stability reinforce each other):
  https://redmonk.com/rstephens/2025/12/18/dora2025/ , https://getdx.com/blog/dora-metrics/
- Deployment is not a release (feature flags): https://www.flagsmith.com/blog/deployment-is-not-a-release ,
  https://launchdarkly.com/blog/why-decouple-deployments-from-releases/
