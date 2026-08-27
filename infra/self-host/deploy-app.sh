#!/usr/bin/env bash
# Bring up the useAgent core stack (backend + frontend + Caddy) on any
# Ubuntu 24.04 host prepared with the base dependencies (bun, node, docker,
# postgres) - a cloud-init-provisioned Hetzner reference host, an AWS/GCP VM,
# or bare metal all work; only root SSH access is assumed.
#
# Usage:
#   SERVER_IP=1.2.3.4 \
#   PUBLIC_ORIGIN=https://useagent.example.com \
#   PG_PASSWORD=... \
#   PG_GATEWAY_PASSWORD=... \
#   BETTER_AUTH_SECRET=... \
#   SECRETS_ENCRYPTION_KEY=... \
#   OPENROUTER_API_KEY=... \
#   SSH_KEY=~/.ssh/id_ed25519 \
#   ./deploy-app.sh /path/to/useagent/repo
#
# Idempotent: re-run to redeploy. Memory-core and the sandbox providers are
# intentionally left out of this "core" bring-up (they need extra secrets and a
# baked Cube template); see README.md.
set -euo pipefail

SERVER_IP=${SERVER_IP:?set SERVER_IP}
PUBLIC_ORIGIN=${PUBLIC_ORIGIN:?set PUBLIC_ORIGIN to the public HTTPS origin}
PG_PASSWORD=${PG_PASSWORD:?set PG_PASSWORD}
PG_GATEWAY_PASSWORD=${PG_GATEWAY_PASSWORD:?set PG_GATEWAY_PASSWORD}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:?set a stable BETTER_AUTH_SECRET (at least 32 characters)}
SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY:?set a stable SECRETS_ENCRYPTION_KEY (at least 32 characters)}
USEAGENT_DEV_MODE=${USEAGENT_DEV_MODE:-false}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
REPO=${1:?pass the path to the useagent repo root}
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new root@"$SERVER_IP")

umask 077

if [[ "$PUBLIC_ORIGIN" != https://* ]]; then
  echo "PUBLIC_ORIGIN must be an HTTPS origin with no path (for example https://useagent.example.com)" >&2
  exit 2
fi
PUBLIC_DOMAIN=${PUBLIC_ORIGIN#https://}
if [[ -z "$PUBLIC_DOMAIN" || "$PUBLIC_DOMAIN" == */* || "$PUBLIC_DOMAIN" == *:* ]]; then
  echo "PUBLIC_ORIGIN must be an HTTPS origin with no path or port" >&2
  exit 2
fi
IFS='.' read -r -a domain_labels <<< "$PUBLIC_DOMAIN"
last_label_index=$(( ${#domain_labels[@]} - 1 ))
if (( ${#domain_labels[@]} < 2 )) || [[ ! "${domain_labels[$last_label_index]}" =~ ^[A-Za-z]{2,63}$ ]]; then
  echo "PUBLIC_ORIGIN must use a public DNS name so Caddy can provision TLS" >&2
  exit 2
fi
for label in "${domain_labels[@]}"; do
  if [[ ! "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]]; then
    echo "PUBLIC_ORIGIN contains an invalid DNS label" >&2
    exit 2
  fi
done
if (( ${#BETTER_AUTH_SECRET} < 32 )); then
  echo "BETTER_AUTH_SECRET must be at least 32 characters" >&2
  exit 2
fi
if (( ${#SECRETS_ENCRYPTION_KEY} < 32 )); then
  echo "SECRETS_ENCRYPTION_KEY must be at least 32 characters" >&2
  exit 2
fi
if [[ "$BETTER_AUTH_SECRET" == "$SECRETS_ENCRYPTION_KEY" ]]; then
  echo "BETTER_AUTH_SECRET and SECRETS_ENCRYPTION_KEY must be independent" >&2
  exit 2
fi
if [[ "$USEAGENT_DEV_MODE" != "true" && "$USEAGENT_DEV_MODE" != "false" ]]; then
  echo "USEAGENT_DEV_MODE must be exactly true or false" >&2
  exit 2
fi
for value in "$PG_PASSWORD" "$PG_GATEWAY_PASSWORD" "$BETTER_AUTH_SECRET" "$SECRETS_ENCRYPTION_KEY" "${OPENROUTER_API_KEY:-}"; do
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "deployment secrets must not contain newline characters" >&2
    exit 2
  fi
done

secret_dir=$(mktemp -d "${TMPDIR:-/tmp}/useagent-self-host.XXXXXX")
cleanup_secrets() {
  rm -f "$secret_dir/backend.env" "$secret_dir/gateway.env"
  rmdir "$secret_dir"
}
trap cleanup_secrets EXIT

cat > "$secret_dir/backend.env" <<ENV
DATABASE_URL=postgres://useagent:${PG_PASSWORD}@localhost:5432/useagent
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY}
BETTER_AUTH_URL=${PUBLIC_ORIGIN}
FRONTEND_ORIGIN=${PUBLIC_ORIGIN}
PORT=3201
NODE_ENV=production
USEAGENT_DEV_MODE=${USEAGENT_DEV_MODE}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
ENV
cat > "$secret_dir/gateway.env" <<ENV
GATEWAY_DATABASE_URL=postgres://useagent_gateway:${PG_GATEWAY_PASSWORD}@localhost:5432/useagent
ENV
chmod 0600 "$secret_dir/backend.env" "$secret_dir/gateway.env"

echo "== wait for cloud-init to finish =="
"${SSH[@]}" 'cloud-init status --wait >/dev/null 2>&1 || true; test -f /opt/useagent-provision/READY && echo provisioned'

echo "== rsync source =="
rsync -az --delete -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude 'dist' \
  --exclude '.turbo' --exclude 'backend/.runs' --exclude '*.log' \
  "$REPO"/backend "$REPO"/frontend "$REPO"/packages "$REPO"/package.json \
  root@"$SERVER_IP":/opt/useagent/

echo "== install private environment files =="
"${SSH[@]}" 'install -d -o root -g root -m 755 /etc/useagent'
rsync -az --chmod=F600 -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
  "$secret_dir/backend.env" "$secret_dir/gateway.env" \
  root@"$SERVER_IP":/etc/useagent/

echo "== write env + build + start (remote) =="
"${SSH[@]}" PUBLIC_DOMAIN="$PUBLIC_DOMAIN" 'bash -s' <<'REMOTE'
set -euo pipefail
umask 077
chmod 0600 /etc/useagent/backend.env /etc/useagent/gateway.env
chown -R useagent:useagent /opt/useagent

# Link the file: workspace packages so their inter-deps and subpath exports
# (e.g. @useagent/agent-harness/canonical) resolve during the frontend type-check.
for p in /opt/useagent/packages/*/; do
  [ -f "${p}package.json" ] && sudo -u useagent bash -lc "cd '$p' && bun install"
done

# systemd units
cat > /etc/systemd/system/useagent-backend.service <<UNIT
[Unit]
Description=UseAgent backend
After=network.target postgresql.service
[Service]
User=useagent
WorkingDirectory=/opt/useagent/backend
EnvironmentFile=/etc/useagent/backend.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/useagent-frontend.service <<UNIT
[Unit]
Description=UseAgent frontend
After=network.target useagent-backend.service
[Service]
User=useagent
WorkingDirectory=/opt/useagent/frontend
Environment=PORT=3400
Environment=USEAGENT_API_ORIGIN=http://localhost:3201
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/useagent-backend.service /etc/systemd/system/useagent-frontend.service

sudo -u useagent bash -lc 'cd /opt/useagent/backend && bun install --frozen-lockfile || bun install'
sudo -u useagent bash -lc 'cd /opt/useagent/frontend && (bun install --frozen-lockfile || bun install) && bun run build'

# Caddy: TLS/HTTP reverse proxy to the frontend (which proxies /api to :3201).
cat > /etc/caddy/Caddyfile <<CADDY
${PUBLIC_DOMAIN} {
  reverse_proxy localhost:3400
}
CADDY
chmod 0644 /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

systemctl daemon-reload
systemctl enable --now useagent-backend useagent-frontend
sleep 3
systemctl --no-pager --lines=0 status useagent-backend useagent-frontend || true
REMOTE

echo "== done. app: $PUBLIC_ORIGIN/  backend health: $PUBLIC_ORIGIN/api/health =="
