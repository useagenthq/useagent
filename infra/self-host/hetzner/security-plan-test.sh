#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
token=$(printf 'a%.0s' {1..64})
common=(
  -refresh=false
  -input=false
  -lock=false
  -var=postgres_password=test-password
  -var=gateway_postgres_password=test-gateway-password
  -var=ssh_public_key_path=/dev/null
)

terraform -chdir="$here" init -backend=false -input=false >/dev/null

expect_rejected() {
  local cidr=$1
  if HCLOUD_TOKEN="$token" terraform -chdir="$here" plan "${common[@]}" \
    -var="allowed_ssh_cidrs=[\"$cidr\"]" >/dev/null 2>&1; then
    echo "expected Terraform to reject world-open SSH CIDR: $cidr" >&2
    exit 1
  fi
}

expect_rejected "0.0.0.0/0"
expect_rejected "0.0.0.0/00"
expect_rejected "::/0"
expect_rejected "::/00"

HCLOUD_TOKEN="$token" terraform -chdir="$here" plan "${common[@]}" \
  -var='allowed_ssh_cidrs=["203.0.113.4/32","2001:db8::1/128"]' >/dev/null

echo "Terraform SSH CIDR security plans passed"
