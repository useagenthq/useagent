<h1 align="center">useAgent</h1>

<p align="center">
  The open-source, self-hostable control plane for coding agents.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-purple.svg" alt="License: AGPL-3.0"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-bun-black.svg" alt="Runtime: bun"></a>
  <a href="docs-site/"><img src="https://img.shields.io/badge/docs-docs--site-blue.svg" alt="Documentation"></a>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick Start</b></a> ·
  <a href="#self-hosting"><b>Self-hosting</b></a> ·
  <a href="docs-site/"><b>Documentation</b></a> ·
  <a href="#architecture"><b>Architecture</b></a>
</p>

---

Run Codex, Claude Code, and OpenCode as durable, threaded sessions in isolated
Linux sandboxes. One event contract, one UI, your infrastructure.

Every run is an event-sourced timeline in Postgres: it survives restarts,
renders through one session grammar regardless of engine, and stays
inspectable after the fact.

## Features

- **Any agent, one interface** - Codex (API key or ChatGPT subscription),
  Claude Code, and OpenCode behind one provider-neutral event contract.
- **Durable runs** - runs survive backend restarts; recovery re-probes live
  sessions and adopts finished work instead of failing it.
- **Real sandboxes** - each thread gets an isolated Linux workstation:
  terminal, repositories, browser, and a visible desktop (noVNC) with MP4
  recording. Daytona and Cube behind one sandbox contract.
- **Trusted gateway** - credentials never enter the sandbox; knowledge,
  memory, skills, GitHub, web search, desktop control, and artifact publishing
  are typed tools served by the backend.
- **Human-in-the-loop** - destructive tools pause on an approval card (web or
  Slack) and resume with a one-shot, argument-bound capability.
- **Skills from GitHub** - import `SKILL.md` files as versioned skills,
  auto-resync, and rank them into every turn.
- **Knowledge, wiki, and team memory** - org-scoped retrieval with citations
  and a human-reviewed learning lane.
- **Slack-native** - mention-to-run, threaded replies, attachments, artifacts,
  and approvals in the thread.
- **Native artifacts** - DOCX, XLSX, PPTX, and PDF with revisioned editing and
  native renderers.

## Quick Start

Requires [bun](https://bun.sh) and Postgres.

```bash
for workspace in \
  packages/agent-harness packages/artifact-workspace \
  packages/agent-client packages/artifact-formats packages/conformance \
  backend frontend; do
  (cd "$workspace" && bun install)
done

bun run dev:backend    # API + orchestration on :3201
bun run dev:frontend   # UI on :3400 (proxies /api/* to the backend)
```

`bun run typecheck` covers every package.

## Self-hosting

[`infra/terraform/hetzner/`](infra/terraform/hetzner/README.md) provisions a
complete host (server, firewall, PostgreSQL + pgvector, bun, Docker, Caddy)
with one `terraform apply`; `deploy-app.sh` brings up the core stack:

```bash
export HCLOUD_TOKEN=...            # never committed
cd infra/terraform/hetzner
terraform init && terraform apply
SERVER_IP=$(terraform output -raw server_ip) PG_PASSWORD=... OPENROUTER_API_KEY=... \
  ./deploy-app.sh /path/to/this/repo
```

That yields a signed-in web UI with model-backed chat. Full engine runs, team
memory, and the sandbox desktop need the additional secrets and sandbox
template documented in the
[Terraform README](infra/terraform/hetzner/README.md#scope-core-vs-full).

Production deploys use two lanes: `bun run deploy:hosted` (fast,
rollback-safe) and `bun run release:hosted` (exhaustive certification with
real engine journeys and automatic rollback). Details in
[`deploy/hetzner/`](deploy/hetzner/).

## Architecture

```
frontend (Next.js)  ->  backend (Bun + Hono + Postgres)  ->  sandboxes (Daytona/Cube)
        UI renders the event log        event-sourced runs,          isolated Linux
        never a live process            trusted tool gateway         workstations
```

| Path | What it owns |
|---|---|
| [`frontend/`](frontend/README.md) | Product UI: chat, sessions, skills, playbooks, wiki, artifacts, automations, settings |
| [`backend/`](backend/README.md) | Control plane: auth, runs, sandboxes, engines, knowledge, memory, artifacts, connectors |
| [`packages/`](packages/) | Shared contracts: thread events, canonical engine events, workpieces, renderers |
| [`docs-site/`](docs-site/README.md) | Documentation site: concepts, architecture, API, operations |
| [`deploy/hetzner/`](deploy/hetzner/) | Release gate, fast deploy lane, atomic frontend release |
| [`infra/terraform/`](infra/terraform/hetzner/README.md) | Reproducible host provisioning and DNS |
| [`memory/`](memory/README.md) | Optional team-memory service |

Deeper reading: the [documentation site](docs-site/) and the interactive
[request-flow diagram](docs/architecture/request-flow.html).

## License

useAgent is open source under the [GNU AGPL v3.0](LICENSE) (AGPL-3.0-only).
Third-party components are listed in [NOTICE](NOTICE); vendored and ported
files carry per-file attribution headers.
