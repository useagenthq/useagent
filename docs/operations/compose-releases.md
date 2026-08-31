# Compose application releases

UseAgent uses the same immutable backend, gateway, and frontend images for local
parity, the single Hetzner application host, and the later Kubernetes lane.
CubeSandbox is infrastructure outside these Compose projects.

## Local parity

```bash
cp deploy/compose/env.example .env.compose
# Replace every placeholder and set RELEASE_COMMIT to `git rev-parse HEAD`.
docker compose --env-file .env.compose -f compose.local.yaml up --build
```

The local project owns only disposable/development PostgreSQL and application
volumes. Set `SANDBOX_PROVIDER=daytona` with a development Daytona key, or point
the containers at a Cube Linux development VM. macOS Docker does not replace
Cube's Linux VM/kernel requirements.

`GATEWAY_PUBLIC_URL` must be an HTTPS origin reachable from the external
sandbox. A Docker service name is neither a valid public gateway origin nor
resolvable from Daytona/Cube. Use a development tunnel or a real development
gateway domain; do not weaken the production URL validator.

## Hetzner candidate project

`compose.prod.yaml` accepts only caller-supplied image references. The private
release orchestrator must run `bun deploy/compose/validate-release.ts` and pass
the validated registry digests, not mutable tags, into Compose:

```text
ghcr.io/useagenthq/useagent-backend@sha256:...
ghcr.io/useagenthq/useagent-gateway@sha256:...
ghcr.io/useagenthq/useagent-frontend@sha256:...
```

It must also set `USEAGENT_GATEWAY_PUBLIC_URL` to the credential-free HTTPS
origin reachable by tenant sandboxes. Candidate validation rejects HTTP,
credentials, paths, query strings, and fragments before Compose starts.

Blue and green projects use separate loopback ports. Frontend and gateway
candidates may overlap where their database/runtime contracts permit, but the
backend may not: provider sealing and realtime fan-out remain process-local and
`REQUIRE_SINGLE_BACKEND=true` must stay enabled.

The backend cutover is therefore serialized:

1. Close run admission and drain the active backend.
2. Stop the active backend.
3. Start the candidate backend on the inactive-color port.
4. Run migration, loopback health, release fingerprint, and bounded smoke gates.
5. Validate Caddy and atomically switch its upstream.
6. Keep the prior image and environment ready, with its backend stopped.

Rollback stops the candidate backend, restarts the prior backend, verifies its
loopback health, then reverses Caddy and reopens admission. Never disable the
single-backend guard to simulate overlapping blue/green backends.

Do not run an in-place `docker compose up` against the active color as a release
procedure. Do not include Cube, host PostgreSQL, memory, OpenConnector, or Caddy
in the application project during the first cutover.

The production Compose definition is a dormant foundation until the private
serialized-cutover orchestrator, container UID/mount preflight, and rollback
rehearsal are complete. In particular, candidate preflight must prove the pinned
`codex` executable is present and the mounted `CODEX_APP_SERVER_HOME_ROOT` is
writable by the backend container user.

The gateway environment must contain only gateway-owned configuration. Current
computer/recording/repository tools still need the single deployment-selected
sandbox provider credential; configure only that active provider's key and
endpoint/template fields. Never place both Cube and Daytona control credentials
in the gateway environment, and never copy the backend environment wholesale.
