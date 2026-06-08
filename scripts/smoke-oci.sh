#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
commit=$(git -C "$repo_root" rev-parse HEAD)
suffix=$$
network="useagent-oci-smoke-${suffix}"
db="useagent-oci-db-${suffix}"
backend="useagent-oci-backend-${suffix}"
gateway="useagent-oci-gateway-${suffix}"
frontend="useagent-oci-frontend-${suffix}"
backend_image="useagent-smoke-backend:${commit}"
gateway_image="useagent-smoke-gateway:${commit}"
frontend_image="useagent-smoke-frontend:${commit}"
postgres_image="pgvector/pgvector:pg16-bookworm@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b"

cleanup() {
  docker rm -f "$frontend" "$gateway" "$backend" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_healthy() {
  local container=$1
  local attempt
  for attempt in $(seq 1 60); do
    if [[ $(docker inspect --format '{{.State.Health.Status}}' "$container") == healthy ]]; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  echo "health check timed out: $container" >&2
  return 1
}

echo "== build native smoke images for ${commit} =="
for service in backend gateway frontend; do
  docker build \
    --file "$repo_root/Dockerfile.${service}" \
    --build-arg "RELEASE_COMMIT=${commit}" \
    --tag "useagent-smoke-${service}:${commit}" \
    "$repo_root"
done

docker network create "$network" >/dev/null
docker run -d --name "$db" --network "$network" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=useagent \
  "$postgres_image" >/dev/null

for attempt in $(seq 1 60); do
  if docker exec "$db" pg_isready -U postgres -d useagent >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    docker logs "$db" >&2 || true
    exit 1
  fi
  sleep 1
done

docker exec "$db" psql -U postgres -d useagent -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE useagent_gateway LOGIN PASSWORD 'gateway';" >/dev/null

database_url="postgres://postgres:postgres@${db}:5432/useagent"
gateway_database_url="postgres://useagent_gateway:gateway@${db}:5432/useagent"
secret_a=$(printf 'a%.0s' {1..64})
secret_b=$(printf 'b%.0s' {1..64})
secret_c=$(printf 'c%.0s' {1..64})
secret_d=$(printf 'd%.0s' {1..64})

echo "== run the release migration as a one-shot container =="
docker run --rm --network "$network" \
  -e "DATABASE_URL=${database_url}" \
  "$backend_image" bun run migrate:release | grep -q RELEASE_DATABASE_READY

docker run -d --name "$backend" --network "$network" \
  -e "DATABASE_URL=${database_url}" \
  -e "BETTER_AUTH_SECRET=${secret_a}" \
  -e "SECRETS_ENCRYPTION_KEY=${secret_b}" \
  -e "USEAGENT_OPERATOR_SECRET=${secret_c}" \
  -e USEAGENT_DEV_MODE=false \
  -e REQUIRE_SINGLE_BACKEND=true \
  -e FRONTEND_ORIGIN=http://frontend:3400 \
  -e BETTER_AUTH_URL=http://frontend:3400 \
  "$backend_image" >/dev/null

docker run -d --name "$gateway" --network "$network" \
  -e "GATEWAY_DATABASE_URL=${gateway_database_url}" \
  -e "PROVIDER_GATEWAY_SECRET=${secret_a}" \
  -e "TOOL_GATEWAY_SECRET=${secret_c}" \
  -e "SECRETS_ENCRYPTION_KEY=${secret_d}" \
  -e USEAGENT_DEV_MODE=false \
  "$gateway_image" >/dev/null

docker run -d --name "$frontend" --network "$network" \
  -e USEAGENT_API_ORIGIN=http://backend:3201 \
  "$frontend_image" >/dev/null

wait_healthy "$backend"
wait_healthy "$gateway"
wait_healthy "$frontend"

for service in backend gateway frontend; do
  container_var=$service
  container=${!container_var}
  revision=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container")
  [[ "$revision" == "$commit" ]] || {
    echo "$service image revision mismatch: $revision != $commit" >&2
    exit 1
  }
done

backend_fingerprint=$(docker exec "$backend" bun -e \
  "fetch('http://127.0.0.1:3201/api/health').then(r=>console.log(r.headers.get('x-useagent-release-fingerprint')))" )
gateway_fingerprint=$(docker exec "$gateway" bun -e \
  "fetch('http://127.0.0.1:3202/api/health').then(r=>console.log(r.headers.get('x-useagent-release-fingerprint')))" )
frontend_commit=$(docker exec "$frontend" node -e \
  "fetch('http://127.0.0.1:3400/healthz').then(r=>r.json()).then(v=>console.log(v.release.commit))" )

[[ "$backend_fingerprint" == "run-events-v1:${commit}" ]]
[[ "$gateway_fingerprint" == "run-events-v1:${commit}" ]]
[[ "$frontend_commit" == "$commit" ]]

echo "OCI_SMOKE_OK ${commit}"
