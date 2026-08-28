# Immutable OCI release lane

This is the additive first phase of the v0.0.2 release-path migration. It builds
three independent OCI images from one committed Git SHA:

- `ghcr.io/useagenthq/useagent-backend:<git-sha>`
- `ghcr.io/useagenthq/useagent-gateway:<git-sha>`
- `ghcr.io/useagenthq/useagent-frontend:<git-sha>`

The backend and gateway use Bun 1.3.14 from a pinned multi-platform digest. The
frontend uses Bun only for its frozen install, then builds and runs the compact
Next standalone server on pinned Node 24. Secrets are not build arguments and
are not copied into an image. Every image carries
`org.opencontainers.image.revision`; the backend and gateway expose the same SHA
through the release-fingerprint response header, and the frontend exposes it at
`GET /healthz`.

## Build and prove locally

Docker must be running. The smoke test builds all three images, starts an
ephemeral pgvector database, runs the release migration in a one-shot backend
container, starts the three services, verifies health, and verifies all release
fingerprints:

```bash
scripts/smoke-oci.sh
```

Build the exact committed SHA for the production `linux/amd64` architecture:

```bash
scripts/build-oci.sh load
```

After authenticating Docker to GHCR, publish those same immutable tags:

```bash
USEAGENT_OCI_REGISTRY=ghcr.io/useagenthq scripts/build-oci.sh push
```

The script refuses a dirty tracked worktree. It never publishes `latest`.

## Kamal 2 configuration

Kamal 2.12 or newer reads the shared configuration and one required destination:

```bash
export USEAGENT_DEPLOY_HOST=<host>
export USEAGENT_REGISTRY_USER=<registry-user>
export KAMAL_REGISTRY_PASSWORD=<registry-token>

kamal config -d backend
kamal config -d gateway
kamal config -d frontend
```

The destinations deliberately preserve the current host boundary:

- Caddy stays host-managed.
- PostgreSQL stays host-managed and reaches the backend through host networking.
- memory and OpenConnector remain external services configured by the existing
  `/etc/useagent/backend.env`.
- the restricted gateway continues to receive both
  `/etc/useagent/backend.env` and `/etc/useagent/gateway.env`.
- artifact, run scratch, Slack upload, and Pi runtime paths retain their current
  host directories.

The database migration is separate from app boot:

```bash
kamal app exec -d backend --primary --version <git-sha> "bun run migrate:release"
```

## Cutover boundary

Do not invoke `kamal deploy` against production yet. These phase-one
destinations use host networking and the existing fixed loopback ports so Caddy
does not change. A candidate container therefore cannot overlap the existing
systemd service on the same port.

The production cutover remains blocked until the private release orchestrator:

1. closes and drains run admission under an operation id;
2. verifies the three SHA-tagged images and runs the one-shot migration;
3. stops the matching systemd service before each destination cutover;
4. deploys with `--skip-push --version <git-sha>` so nothing rebuilds;
5. executes the existing parity and release gates;
6. reopens admission only after all three live fingerprints match; and
7. restores the prior SHA-tagged images before reopening admission on failure.

True overlapping, gapless replacement requires a later Caddy-to-kamal-proxy
loopback handoff. That routing change belongs to private operations and is not
part of this additive public-repository phase.
