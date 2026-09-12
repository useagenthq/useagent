# Adopt a systemd deployment into Compose

Use `adopt-systemd` once to move an existing three-service systemd deployment
onto the immutable Compose release lane. The command runs from an operator
machine over SSH. It does not build on the host, run provider certification, or
assume a specific VPS vendor.

After a successful adoption, use the ordinary `promote` command for the next
release. Ordinary rollback becomes available after that promotion records a
previous Compose release; it does not switch back to systemd. Do not run
`adopt-systemd` again.

## Why ordinary bootstrap refuses this host

An empty Compose release history normally means a new host. `promote` therefore
requires no running release backend and unused blue and green backend ports. A
legacy systemd deployment already owns the blue ports (`3201`, `3202`, and
`3400`), so
ordinary bootstrap stops before changing the host. This prevents two backends
from sharing one database and prevents Compose from silently taking ownership
of a systemd deployment.

`adopt-systemd` is the explicit exception. It treats the healthy systemd
services as the blue source, stages the immutable Compose release on green, and
performs one bounded cutover.

## Configure the operator machine

Run the command from the repository checkout that contains `deploy/promote.ts`,
`compose.prod.yaml`, and `deploy/compose/Caddyfile`.

The following values are required:

```bash
export USEAGENT_PROMOTE_HOST='<ssh-user>@<host>'
export USEAGENT_PROMOTE_APP_DOMAIN='<application-domain>'
export USEAGENT_PROMOTE_GATEWAY_DOMAIN='<gateway-domain>'
```

Use one SSH authentication option when the default SSH configuration is not
sufficient:

```bash
export USEAGENT_PROMOTE_SSH_KEY='<absolute-path-to-private-key>'
# Or: export USEAGENT_PROMOTE_SSH_CONFIG='<absolute-path-to-ssh-config>'
```

The adoption-specific settings have these defaults:

| Variable | Default |
| --- | --- |
| `USEAGENT_LEGACY_SOURCE_ROOT` | `/opt/useagent` |
| `USEAGENT_LEGACY_BACKEND_UNIT` | `useagent-backend.service` |
| `USEAGENT_LEGACY_GATEWAY_UNIT` | `useagent-gateway.service` |
| `USEAGENT_LEGACY_FRONTEND_UNIT` | `useagent-frontend.service` |

Override a unit only with a complete `.service` name. The common release
settings retain their normal defaults:

| Variable | Default |
| --- | --- |
| `USEAGENT_PROMOTE_STATE_ROOT` | `/var/lib/useagent` |
| `USEAGENT_BACKEND_ENV_FILE` | `/etc/useagent/backend.env` |
| `USEAGENT_GATEWAY_ENV_FILE` | `/etc/useagent/gateway.env` |
| `USEAGENT_CADDY_CONFIG` | `/etc/caddy/Caddyfile` |
| `USEAGENT_CADDY_ENV_FILE` | `/etc/useagent/caddy.env` |
| `USEAGENT_COMPOSE_FILE` | `compose.prod.yaml` in the operator checkout |
| `USEAGENT_CADDY_TEMPLATE` | `deploy/compose/Caddyfile` in the operator checkout |

Secrets stay in the existing host environment files. Do not put their contents
in the command, release manifest, or adoption journal.

## Run the one-time adoption

Use the release manifest produced by the image workflow and the exact lowercase
40-character commit fingerprint reported by all three legacy services:

```bash
bun run deploy/promote.ts adopt-systemd \
  --manifest '<path-to-release-manifest.json>' \
  --legacy-commit '<40-character-legacy-commit>'
```

Do not substitute a branch name, tag, or short SHA for `--legacy-commit`.

## Preflight contract

Preflight makes no routing or admission change. It requires all of the
following before the cutover starts:

- Compose release history is empty and no release-labelled backend container
  is running.
- The legacy backend, gateway, and frontend units are active. Their original
  enabled or disabled states are recorded in the journal for exact recovery.
- The green ports (`3211`, `3212`, and `3410`) are unused.
- Direct health responses from all three legacy services report the supplied
  legacy commit.
- The live Caddy configuration exists. Its durable backup hash matches the
  adoption journal, and its legacy backend, frontend, and gateway upstreams are
  unambiguous.
- The manifest contains three immutable image digests whose image revision
  labels match the manifest commit.
- The staged Compose and Caddy configurations validate, and the target release
  migration completes. This expansion work happens before admission closes.
- Missing runtime directories can be created and every required runtime path is
  writable by the target backend. Both `bun` and `codex` are available inside
  it.

The target frontend and gateway then start on green and pass direct health
checks while run admission remains open.

## Cutover phases

The command journals every phase in `systemd-adoption.json` under
`USEAGENT_PROMOTE_STATE_ROOT`, stores a hash-bound Caddy backup beside it, and
holds the same remote promotion lock used by later releases.

1. Capture and hash the live Caddy configuration, stage the green release, and
   warm the green frontend and gateway with admission open.
2. Close run admission, drain the legacy backend for at most 10 seconds, stop
   it, and prove that it is no longer healthy.
3. Start the green backend and verify its direct release fingerprint.
4. Validate and switch Caddy to green, then verify the public frontend,
   backend, and gateway fingerprints.
5. Disable the three legacy units, commit green as the current Compose release,
   reopen admission, stop the legacy frontend and gateway, and clear the
   adoption journal.

The close, drain, backend swap, routing switch, public verification, and reopen
share a 30-second admission budget. At most one backend is allowed to be
healthy throughout the swap.

## Failure and recovery

A failure before admission closes stops the staged green edge and leaves the
legacy deployment serving.

A failure after admission closes compensates toward the verified legacy state:
it restores each legacy unit's original enabled or disabled state, stops the
target backend, starts the legacy backend if necessary, restores the
hash-verified Caddy backup, verifies all legacy public fingerprints, resets
Compose history, and only then reopens admission.

If the target backend cannot be stopped, the legacy backend cannot be restored,
or legacy public verification fails, the command leaves admission closed and
persists a `failed-closed` journal. Do not delete or edit that journal. Rerun the
same command with the same manifest and legacy commit. Recovery finishes the
forward adoption only when committed history names a healthy target; otherwise
it resets history and compensates to legacy.

## Result and timing

The final line is JSON. A completed adoption reports the active commit and
color plus these measurements:

```json
{
  "status": "complete",
  "command": "adopt-systemd",
  "commit": "<target-commit>",
  "color": "green",
  "metrics": {
    "wallClockMs": 0,
    "admissionClosedMs": 0,
    "rollbackMs": null,
    "paidCanaryRuns": 0
  }
}
```

The numeric values above show the response shape, not expected durations. The
release target is at most five minutes wall-clock and at most 30 seconds with
admission closed. Provider certification is asynchronous and never runs in
this adoption path, so `paidCanaryRuns` remains `0`.

Only `status: "complete"` exits successfully. A compensated or failed-closed
result prints the same measurement shape and exits nonzero.
