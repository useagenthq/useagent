#!/usr/bin/env bash
# Bring up the Skynet core stack (backend + frontend + Caddy) on a host that
# cloud-init has already prepared (bun, node, docker, postgres installed).
#
# Usage:
#   SERVER_IP=1.2.3.4 \
#   PG_PASSWORD=... \
#   OPENROUTER_API_KEY=... \
#   SSH_KEY=~/.ssh/id_ed25519 \
#   ./deploy-app.sh /path/to/skynet/repo
#
# Idempotent: re-run to redeploy. Memory-core and the sandbox providers are
# intentionally left out of this "core" bring-up (they need extra secrets and a
# baked Cube template); see README.md.
set -euo pipefail

SERVER_IP=${SERVER_IP:?set SERVER_IP}
PG_PASSWORD=${PG_PASSWORD:?set PG_PASSWORD}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
REPO=${1:?pass the path to the skynet repo root}
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new root@"$SERVER_IP")

echo "== wait for cloud-init to finish =="
"${SSH[@]}" 'cloud-init status --wait >/dev/null 2>&1 || true; test -f /opt/skynet-provision/READY && echo provisioned'

echo "== rsync source =="
rsync -az --delete -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
  --exclude '.git' --exclude 'node_modules' --exclude '.next' --exclude 'dist' \
  --exclude '.turbo' --exclude 'backend/.runs' --exclude '*.log' \
  "$REPO"/backend "$REPO"/frontend "$REPO"/packages "$REPO"/package.json \
  root@"$SERVER_IP":/opt/skynet/

echo "== write env + build + start (remote) =="
"${SSH[@]}" OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" PG_PASSWORD="$PG_PASSWORD" 'bash -s' <<'REMOTE'
set -euxo pipefail
install -d -o root -g root -m 755 /etc/skynet
AUTH_SECRET=$(openssl rand -hex 32)
cat > /etc/skynet/backend.env <<ENV
DATABASE_URL=postgres://skynet:${PG_PASSWORD}@localhost:5432/skynet
BETTER_AUTH_SECRET=${AUTH_SECRET}
BETTER_AUTH_URL=http://localhost:3400
PORT=3201
SKYNET_DEV_MODE=1
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
ENV
chown -R skynet:skynet /opt/skynet

# Link the file: workspace packages so their inter-deps and subpath exports
# (e.g. @skynet/agent-harness/canonical) resolve during the frontend type-check.
for p in /opt/skynet/packages/*/; do
  [ -f "${p}package.json" ] && sudo -u skynet bash -lc "cd '$p' && bun install"
done

# systemd units
cat > /etc/systemd/system/skynet-backend.service <<UNIT
[Unit]
Description=Skynet backend
After=network.target postgresql.service
[Service]
User=skynet
WorkingDirectory=/opt/skynet/backend
EnvironmentFile=/etc/skynet/backend.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/skynet-frontend.service <<UNIT
[Unit]
Description=Skynet frontend
After=network.target skynet-backend.service
[Service]
User=skynet
WorkingDirectory=/opt/skynet/frontend
Environment=PORT=3400
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT

sudo -u skynet bash -lc 'cd /opt/skynet/backend && bun install --frozen-lockfile || bun install'
sudo -u skynet bash -lc 'cd /opt/skynet/frontend && (bun install --frozen-lockfile || bun install) && bun run build'

# Caddy: TLS/HTTP reverse proxy to the frontend (which proxies /api to :3201).
cat > /etc/caddy/Caddyfile <<CADDY
:80 {
  reverse_proxy localhost:3400
}
CADDY
systemctl reload caddy || systemctl restart caddy

systemctl daemon-reload
systemctl enable --now skynet-backend skynet-frontend
sleep 3
systemctl --no-pager --lines=0 status skynet-backend skynet-frontend || true
REMOTE

echo "== done. app: http://$SERVER_IP/  backend health: http://$SERVER_IP/api/health =="
