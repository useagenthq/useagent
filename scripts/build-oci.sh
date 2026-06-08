#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
commit=$(git -C "$repo_root" rev-parse HEAD)
registry=${USEAGENT_OCI_REGISTRY:-ghcr.io/useagenthq}
mode=${1:-load}

if [[ "$mode" != "load" && "$mode" != "push" ]]; then
  echo "usage: $0 [load|push]" >&2
  exit 2
fi
if [[ -n $(git -C "$repo_root" status --porcelain) ]]; then
  echo "refusing to publish an OCI release from a dirty worktree" >&2
  exit 2
fi

output=(--load)
if [[ "$mode" == "push" ]]; then
  output=(--push)
fi

for service in backend gateway frontend; do
  image="${registry}/useagent-${service}:${commit}"
  echo "== build ${image} =="
  docker buildx build \
    --platform linux/amd64 \
    --file "$repo_root/Dockerfile.${service}" \
    --build-arg "RELEASE_COMMIT=${commit}" \
    --provenance=mode=max \
    --sbom=true \
    --tag "$image" \
    "${output[@]}" \
    "$repo_root"
done

echo "OCI_RELEASE_BUILT ${commit}"
