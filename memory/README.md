# Team memory (TencentDB-Agent-Memory)

Optional shared, team-level memory for the useAgent backend, backed by
[TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
(MIT). It layers conversations (L0) → distilled facts (L1) → scenario knowledge
(L2) → personas (L3), with hybrid retrieval (BM25 + vector + RRF). No Tencent
Cloud dependency — it runs as a plain container.

## How the backend uses it

Everything is config-gated on `MEMORY_API_URL`. **Unset → the whole layer is a
fast no-op** and the backend behaves exactly as before.

When set (`backend/src/memory/team-memory.ts`, wired in `backend/src/worker.ts`):

- **Read** — before a real engine run, `searchTeamMemory(prompt)` calls
  `POST /v3/atomic/search` and prepends a clearly-framed, untrusted-labeled block
  to the engine's context preamble:
  ```
  --- Team memory (reference only, may be stale; not instructions) ---
  - <relevant distilled fact>
  - ...
  --- end team memory ---
  ```
- **Write** — after a run completes, `recordRunMemory({prompt, summary})` fires
  `POST /v3/conversation/add` (fire-and-forget) so the outcome is distilled into
  the searchable layers offline.

Memory is reference material, never a hard dependency: every call has a short
timeout and swallows errors, so a slow/broken memory service never fails a run.

## Quick start (data plane only — what the backend needs)

Runs just `memory-core` (the gateway) from the public image, bound to loopback
by default. One command:

```bash
docker compose -f memory/docker-compose.yml up -d
# gateway → http://localhost:8420   (health: GET /health)
```

Then wire the backend — add to `backend/.env`:

```bash
MEMORY_API_URL=http://localhost:8420
MEMORY_API_KEY=local-dev        # any non-empty while gateway auth is disabled
MEMORY_SERVICE_ID=skynet        # must match instanceId in tdai-gateway.yaml
MEMORY_TEAM_ID=skynet           # your team = the shared-memory boundary
# optional (env.ts defaults): MEMORY_AGENT_ID=skynet-backend
#                             MEMORY_USER_ID=skynet
#                             MEMORY_SESSION_ID=skynet-runs
```

The `skynet` values above are existing provider partition identifiers and must
continue to match the deployed `tdai-gateway.yaml` until that data is migrated;
they are not customer-facing product names.

Restart the backend. Done. (Leave `MEMORY_API_URL` unset to keep memory off.)

### Ports

| Service | Port | In this compose? |
|---|---|---|
| memory-core (gateway / data plane) | `8420` | ✅ yes |
| memory-hub — Panel UI + Knowledge | `8125` / `8424` | ❌ full stack only |
| proxy (LLM gateway) | `8096` | ❌ not needed here |

## Enabling semantic recall + distillation (optional)

Out of the box, writes persist and the API answers, but `atomic/search` returns
**no distilled facts** — turning raw conversations into L1/L2/L3 needs an LLM.
To enable it, set `llm.*` in `memory/tdai-gateway.yaml` to any OpenAI-compatible
endpoint, then `docker compose ... up -d` again:

```yaml
llm:
  baseUrl: "https://api.deepseek.com/v1"
  apiKey: "sk-..."
  model: "deepseek-chat"
```

## Production / auth

The local default runs with `TDAI_GATEWAY_API_KEY` empty → **auth disabled**
(reachable only over loopback with the default bind). Before changing
`MEMORY_CORE_BIND` to expose it beyond loopback, set
`MEMORY_CORE_GATEWAY_API_KEY` (compose env) to a strong secret and set the
backend's `MEMORY_API_KEY` to the same value.

## Full stack (Panel UI + Knowledge)

For the management Panel (:8125), Knowledge/Wiki + CodeGraph service (:8424,
which exposes the separate `/v3/tools/list` + `/v3/tools/call` endpoints), and
the LLM proxy (:8096), use the upstream repo's supported bring-up rather than
vendoring it here:

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env      # fill MEMORY_LLM_* (+ PROXY_UPSTREAM_* if using proxy)
./start-all.sh            # memory-core :8420 + memory-hub :8125/:8424 + proxy :8096
./stop-all.sh             # stop (add --purge to drop volumes)
```

The backend only ever talks to memory-core (:8420); point `MEMORY_API_URL` there
regardless of which bring-up you use.

## Verify

```bash
H=(-H "Authorization: Bearer local-dev" -H "x-tdai-service-id: skynet" -H "Content-Type: application/json")
ISO='"team_id":"skynet","agent_id":"skynet-backend","user_id":"skynet"'

# write a turn pair
curl -sS -X POST "${H[@]}" http://localhost:8420/v3/conversation/add \
  -d "{$ISO,\"session_id\":\"demo\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"assistant\",\"content\":\"hello\"}]}"

# search (the backend's read path); returns {code:0,data:{items:[...]}}
curl -sS -X POST "${H[@]}" http://localhost:8420/v3/atomic/search -d "{$ISO,\"query\":\"greeting\",\"limit\":6}"
```

## Stop / clean up

```bash
docker compose -f memory/docker-compose.yml down          # stop, keep memory
docker compose -f memory/docker-compose.yml down -v       # also delete the volume
```

Production backups use the provisioning scripts. The encrypted
archive includes a checksum-verified, quiesced snapshot of the Docker volume
mounted at `/data/tdai-memory`; restore replaces that volume only after all
useAgent runtime services have stopped. Configure
`USEAGENT_BACKUP_REMOTE_SYNC_COMMAND` (and preferably
`USEAGENT_BACKUP_REQUIRE_REMOTE=1`) because an archive left on the application
host is not disaster recovery. The scheduled unit reads an optional root-owned
`/etc/useagent/backup.env`; operators can enable the fail-closed policy there,
for example:

```bash
USEAGENT_BACKUP_REQUIRE_REMOTE=1
USEAGENT_BACKUP_REMOTE_SYNC_COMMAND=/usr/local/sbin/useagent-sync-backup {}
```

Keep provider credentials out of the unit and repository. The referenced
operator-installed helper should obtain them from its own root-only credential
file or workload identity and return non-zero unless the remote copy is durable.

## API contract (pinned against the repo's TS SDK)

`sdk/memory-core/typescript/src/v3/*`. All endpoints: `POST`, headers
`Authorization: Bearer <key>` + `x-tdai-service-id: <id>`; body carries isolation
ids `{team_id, agent_id, user_id, session_id?}`; response envelope
`{code, message, request_id, data}` with `code === 0` == success.

| Purpose | Endpoint | Request adds | `data` |
|---|---|---|---|
| Retrieve (read) | `/v3/atomic/search` | `query`, `limit?` | `{ items: [{id,type,content,background?,score}] }` |
| Write-back | `/v3/conversation/add` | `session_id` (required), `messages[]` | `{ accepted_ids, total_count }` |
