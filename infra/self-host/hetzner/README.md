# Reproducible useAgent host on Hetzner Cloud

One `terraform apply` provisions a server and its dependencies; one `../deploy-app.sh`
brings up the useAgent **core stack** (backend + frontend + Caddy) on it. This turns
"bring your own host" into reproducible infrastructure-as-code.

The infrastructure path has been verified end to end: provision -> boot -> a
live model turn -> destroy (see [Verified](#verified)). The current public UI
does not expose self-service signup; production operators must provision access
through their chosen identity/admin lane.

## What it provisions

| Resource | Purpose |
|---|---|
| `hcloud_server` (Ubuntu 24.04) | The host. Default `cpx31` (4 vCPU / 8 GB). |
| `hcloud_firewall` | Inbound 22 (SSH), 80, 443. |
| `hcloud_ssh_key` | Your key for root SSH (or reference an existing one). |
| cloud-init | Installs bun (pinned 1.3.14), Node 24, Docker, Caddy, PostgreSQL 16 + pgvector, 4 GB swap, and a **throwaway `useagent` database** with owner and restricted gateway roles. |

The database is local and isolated, so this host never shares a database with any
other useAgent backend (the platform supports exactly one backend per database).

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform) >= 1.5
- A Hetzner Cloud **API token** (Project -> Security -> API Tokens, Read & Write)
- An SSH key pair

## Provision

```bash
export HCLOUD_TOKEN=your-hetzner-api-token   # never commit this
cp terraform.tfvars.example terraform.tfvars # then edit it (gitignored)

terraform init
terraform apply
```

`terraform.tfvars` at minimum:

```hcl
ssh_public_key_path = "~/.ssh/id_ed25519.pub"
postgres_password   = "a-strong-secret"
gateway_postgres_password = "a-different-strong-secret"
allowed_ssh_cidrs   = ["203.0.113.4/32"] # replace with your public IP
```

To reuse an SSH key already in your Hetzner project instead of creating one, set
`create_ssh_key = false` and `ssh_key_name = "<existing-name>"`.

Wait for provisioning to finish:

```bash
ssh root@$(terraform output -raw server_ip) 'cloud-init status --wait'
```

## Deploy the app

```bash
SERVER_IP=$(terraform output -raw server_ip) \
PUBLIC_ORIGIN=https://useagent.example.com \
PG_PASSWORD='the-postgres-password' \
PG_GATEWAY_PASSWORD='the-gateway-postgres-password' \
BETTER_AUTH_SECRET='stable-random-value-at-least-32-characters' \
SECRETS_ENCRYPTION_KEY='different-stable-value-at-least-32-characters' \
BOOTSTRAP_ADMIN_EMAIL='owner@example.com' \
BOOTSTRAP_ADMIN_PASSWORD='a-strong-initial-password' \
OPENROUTER_API_KEY=sk-or-...        \
SSH_KEY=~/.ssh/id_ed25519           \
../deploy-app.sh /path/to/useagent/repo
```

This rsyncs the source, installs dependencies, links the `file:` workspace
packages, builds the Next.js frontend, installs systemd units for the backend and
frontend, and points Caddy at the frontend. Re-run it to redeploy.

Point the `PUBLIC_ORIGIN` DNS name at the server before deploying. Caddy obtains
and renews the TLS certificate automatically. Keep both application secrets
stable across redeploys; changing them without an intentional rotation logs out
users or makes encrypted org secrets unreadable.

For a fresh database, the bootstrap variables create the first user and personal
organization through Better Auth after the production backend becomes healthy.
The process is one-time and idempotent, and its transient password file is
deleted immediately. Omit both variables after the first successful deployment;
the running production service keeps public signup disabled.

Then:

- App: `https://<your-domain>/`
- Backend health: `https://<your-domain>/api/health` -> `200`

## Scope: "core" vs "full"

This brings up the **core** product: the API, the web UI, auth, knowledge, and
model-backed **chat** (via `OPENROUTER_API_KEY`). That is enough to sign in and
hold a real model conversation.

**Full** engine runs (Codex / Claude / OpenCode in a sandbox), team memory, and
the desktop need more that an operator supplies:

| Capability | What it needs |
|---|---|
| Sandbox agent runs | A sandbox provider (Daytona or Cube) and, for Cube, a **baked sandbox template** (`bake-sandbox-template.sh`). |
| Team memory (English) | The memory-core container (`memory/docker-compose.yml`) and an `MEMORY_LLM_*` key. |
| Managed Codex / provider keys | Provider connections configured in the app. |
| Everything | Host provisioning env (service accounts, secrets) set during setup. |

Point the extra env at `/etc/useagent/backend.env` and restart `useagent-backend`.

## Verified

Against a real `cpx31` in `ash`:

- cloud-init installed the full dependency set; the throwaway `useagent` DB came up
  with pgvector.
- The backend migrated the schema (37 tables) and served `/api/health` -> `200`.
- The Next.js 16 frontend built and served behind Caddy.
- A better-auth sign-up created a user + org, and `POST /api/chat` returned a live
  model completion over SSE (`delta: "PONG"`).

## Teardown

The server bills by the hour. Destroy it when done:

```bash
terraform destroy
```

## Notes

- The Hetzner token is read from `HCLOUD_TOKEN` only; it is never written to a file
  or committed. `terraform.tfvars`, state, and `.terraform/` are gitignored.
- PostgreSQL passwords are rendered into cloud-init user data and therefore make
  the Terraform state sensitive. Store state in an encrypted, access-controlled
  backend and never publish or attach it to bug reports.
- `allowed_ssh_cidrs` is required and rejects world-open `/0` ranges. Use your
  public IP with `/32` (IPv4) or `/128` (IPv6).
- Production is the default. Set `USEAGENT_DEV_MODE=true` only for a disposable,
  access-restricted development deployment.
- bun is pinned to 1.3.14 because bun >= 1.4 rejects the repo's `file:../packages/*`
  dependencies ("unsafe folder path").
- Ubuntu 24.04 ships PostgreSQL 16, hence `postgresql-16-pgvector`. On a different
  base image, match the package to the server's Postgres major.
