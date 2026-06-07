# Reproducible useAgent host on Hetzner Cloud

One `terraform apply` provisions a server and its dependencies; one `../deploy-app.sh`
brings up the useAgent **core stack** (backend + frontend + Caddy) on it. This turns
"bring your own host" into reproducible infrastructure-as-code.

This was verified end to end: provision -> boot -> a live model turn -> destroy
(see [Verified](#verified)).

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
PG_PASSWORD='the-postgres-password' \
PG_GATEWAY_PASSWORD='the-gateway-postgres-password' \
OPENROUTER_API_KEY=sk-or-...        \
SSH_KEY=~/.ssh/id_ed25519           \
../deploy-app.sh /path/to/skynet/repo
```

This rsyncs the source, installs dependencies, links the `file:` workspace
packages, builds the Next.js frontend, installs systemd units for the backend and
frontend, and points Caddy at the frontend. Re-run it to redeploy.

Then:

- App: `http://<server_ip>/`
- Backend health: `http://<server_ip>/api/health` -> `200`

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
- bun is pinned to 1.3.14 because bun >= 1.4 rejects the repo's `file:../packages/*`
  dependencies ("unsafe folder path").
- Ubuntu 24.04 ships PostgreSQL 16, hence `postgresql-16-pgvector`. On a different
  base image, match the package to the server's Postgres major.
