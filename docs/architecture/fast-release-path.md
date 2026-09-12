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
unit/integration/contract   download artifact + verify sha         scheduled synthetic runs:
build artifact (frontend    migration check (expansion-safe)       parity matrix, approvals,
standalone + backend)       drain <= 30 s, swap, restart           questions, cancel, pi,
upload keyed by commit      /api/health + release marker           product-child fan-out
                            provider-readiness (auth only)         budgeted per day
                            ONE cheap 1-turn run per engine        alert -> rollback command
```

Hard constraint: exactly one backend per database (boot recovery reconciles
other processes' in-flight runs). So the swap is drain -> stop -> start, with
admission closed for the swap window only (target <= 30 s). True overlap
(Kamal-style) needs lease-owner-aware recovery (slice 6); until then, 30 s.

Budgets: promote wall-clock <= 5 min; admission closed <= 30 s per promote;
rollback <= 60 s; a frontend-only change <= 3 min end to end.

## Slices (one PR each, in this order; each has a measured acceptance)

1. **Open admission after the 2/17 health check; close only for the 15/17 swap.**
   Delete the drain at gate start. Accept: admission-closed window per attempt
   <= 60 s (from the admission log). Biggest user-facing win, ~20 lines.
2. **Classify failures; resume instead of rollback.** Probe error / SSH timeout /
   invalid probe -> keep the healthy candidate serving, exit with a resume hint,
   evidence cache reused (it already exists). Product error -> rollback. Accept:
   an SSH timeout no longer rolls back a candidate that passed health.
3. **Artifact from CI.** GitHub Actions builds `frontend` (Next standalone) and
   `backend` once per main commit, uploads a tarball keyed by commit (GHCR image
   later if wanted). Host: `/opt/useagent/releases/<sha>` + `current` symlink;
   deploy = download, verify sha, swap symlink, restart; rollback = re-point +
   restart. No `bun install` or `bun run build` on the host. Accept: promote
   <= 90 s, rollback <= 30 s.
4. **Parallel parity + scope-aware lane.** `PARITY_CONCURRENCY=3` with a Daytona
   headroom check. `--scope frontend` (diff vs deployed commit touches only
   `frontend/**`): build + swap + restart frontend, `/api/health`, one page
   smoke. Accept: a theme-only change deploys in <= 3 min.
5. **Move the matrix out of the critical path.** approval / question / cancel /
   desktop-recording / artifact-publish / pi / product-child canaries become a
   scheduled `certify` job against the promoted release (budgeted runs per day,
   evidence written, Slack alert on failure, `deploy rollback` to the previous
   release dir). Critical path keeps: health, migration check, provider
   readiness, one cheap single-turn run per engine. Accept: promote <= 5 min on
   a backend change.
6. **(Optional) lease-owner-aware boot recovery** so two backends can overlap for
   ~10 s -> admission never closes. Only after 1-5 are measured.

## Test discipline for this work

The deploy tree has ~150 files, most of them one test per shell script. New
slices add tests only for pure planner/classifier logic (scope classifier,
failure classifier, artifact manifest). No new test per bash step. Prefer
deleting a gate step to testing it. `deploy/hetzner` file count must go down,
not up. Every PR reports before/after numbers for: promote wall-clock,
admission-closed seconds, rollback seconds, paid runs per promote.

## Prompt for the implementing agent

> Implement `docs/architecture/fast-release-path.md` slice by slice, one PR per
> slice, in order 1 -> 5. Do not touch a running deployment. Before slice 1,
> record the baseline from the host: promote wall-clock, admission-closed
> seconds, rollback seconds, paid canary runs per promote. Each PR must report
> the same four numbers after the change and meet the slice's acceptance line.
> Do not add canaries, gate steps, or a test per script; tests only for pure
> planner/classifier logic. The `deploy/hetzner` file count must not grow. Keep
> `REQUIRE_SINGLE_BACKEND=1` semantics: swap is drain -> stop -> start, admission
> closed for the swap window only. Slice 1 is a ~20-line change to
> `release-gate.sh` (open admission after 2/17 health, close before 15/17) and
> must ship today.

## Sources

- Kamal (single host: build once, health check, proxy switch, rollback is a
  pointer flip): https://blog.saeloun.com/2026/07/23/rails-8-kamal-2-deployment-zero-downtime ,
  https://wolf-tech.io/blog/kamal-2-production-zero-downtime-deploys-secrets
- Google SRE Workbook, Canarying Releases: https://sre.google/workbook/canarying-releases/
- DORA / State of DevOps (throughput and stability reinforce each other):
  https://redmonk.com/rstephens/2025/12/18/dora2025/ , https://getdx.com/blog/dora-metrics/
- Deployment is not a release (feature flags): https://www.flagsmith.com/blog/deployment-is-not-a-release ,
  https://launchdarkly.com/blog/why-decouple-deployments-from-releases/
