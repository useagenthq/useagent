# Self-hosting useAgent

useAgent runs on **any Linux host you can SSH into as root** - an AWS or
Google Cloud VM, Azure, Hetzner, DigitalOcean, or bare metal. Nothing in the
control plane is provider-specific: the host needs Ubuntu 24.04 (or
equivalent), bun, Node, Docker, PostgreSQL 16 with pgvector, and Caddy.

## Two paths to a host

1. **Bring your own host (any provider).** Provision an Ubuntu 24.04 machine
   however you like (4 vCPU / 8 GB RAM is a comfortable start for the core
   stack), install the base dependencies (the package list lives in
   [`hetzner/cloud-init.yaml`](hetzner/cloud-init.yaml) - it is plain apt/
   shell and works verbatim as a user-data script on AWS, GCP, or Azure),
   then run [`deploy-app.sh`](deploy-app.sh) from your machine:

   ```bash
   SERVER_IP=<host-ip> PUBLIC_ORIGIN=https://useagent.example.com \
     PG_PASSWORD=... PG_GATEWAY_PASSWORD=... \
     BETTER_AUTH_SECRET=... SECRETS_ENCRYPTION_KEY=... USEAGENT_OPERATOR_SECRET=... \
     OPENROUTER_API_KEY=... \
     BOOTSTRAP_ADMIN_EMAIL=owner@example.com BOOTSTRAP_ADMIN_PASSWORD=... \
     ./deploy-app.sh /path/to/useagent/repo
   ```

2. **One-command reference host (Hetzner via Terraform).** The
   [`hetzner/`](hetzner/README.md) subfolder provisions a complete host
   (server, firewall, PostgreSQL + pgvector, bun, Docker, Caddy) with a
   single `terraform apply`. It is a reference implementation, not a
   requirement - port the ~200 lines of Terraform to your provider of choice
   and everything downstream is identical.

Either path yields the production web UI and model-backed chat for provisioned
users. The public UI does not expose self-service signup; operators must
provision access through their chosen identity/admin lane. Full production
operation (release gates, backups, systemd units) is documented in
The provisioning scripts (host setup, systemd units, sandbox image) -
those scripts address the host by SSH and are provider-agnostic.

## Choosing a sandbox provider

Agent runs execute inside isolated Linux sandboxes. Two providers sit behind
one contract (`SANDBOX_PROVIDER`):

| Provider | What it is | Host requirements |
|---|---|---|
| **Daytona** (`SANDBOX_PROVIDER=daytona`) | Managed sandboxes as a service - the sandbox fleet runs on Daytona's infrastructure. | None beyond an API key. Pairs with a control-plane host on **any** cloud (AWS, GCP, a small VM anywhere). The easiest start. |
| **CubeSandbox** (`SANDBOX_PROVIDER=cube`) | Self-hosted sandbox runtime (Docker-based, E2B-compatible protocol) - the sandbox fleet runs on your own hardware. | A beefy host or separate machine (the reference deployment uses a dedicated Hetzner server), a baked sandbox template, and the cube-* sandbox services. Full data locality, no per-sandbox SaaS costs. |

Start with Daytona to get running quickly; move to CubeSandbox when you want
the fleet on your own metal.

## DNS

[`../terraform/prod/`](../terraform/prod/README.md) manages only the
Cloudflare DNS boundary for the hosted deployment and is not needed for
self-hosting; point any DNS record at your host and set the domain in the
backend environment.

`deploy-app.sh` requires a public HTTPS origin and configures Caddy to obtain
and renew its TLS certificate. Point the domain at the server before deploying
and allow inbound ports 80 and 443. Generate `BETTER_AUTH_SECRET`,
`SECRETS_ENCRYPTION_KEY`, and `USEAGENT_OPERATOR_SECRET` once (at least 32
characters each), store them safely, and reuse the same values for every
redeploy. Rotating a key is a separate operator procedure; silently regenerating
them invalidates sessions, operator access, or stored org secrets.

For example, generate each application secret separately with
`openssl rand -hex 32`. Use URL-safe database passwords because they are placed
in PostgreSQL connection URLs.

Production is the default (`USEAGENT_DEV_MODE=false`). A disposable development
deployment may opt in explicitly with `USEAGENT_DEV_MODE=true`; never expose that
mode to untrusted users.

On the first deployment of a fresh database, set `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` (minimum 12 characters). The deploy runs a one-time
Better Auth signup process after the production backend is healthy, creates the
user and personal organization through the application auth hooks, then deletes
the transient credential file. Reusing the same email is idempotent. Omit both
variables on later deploys. The long-running backend never enables public signup.
