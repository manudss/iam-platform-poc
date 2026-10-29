#!/usr/bin/env bash
# Prepare a fresh machine (or Codespace) for the local demo: Dolt binary, Rust core build, npm installs, Dolt seed.
# Idempotent. No Docker, no paid service.
set -euo pipefail
cd "$(dirname "$0")/.."
DOLT_VERSION="${DOLT_VERSION:-v2.6.1}"
if ! command -v dolt >/dev/null; then
  mkdir -p /tmp/doltdl && curl -sSfL "https://github.com/dolthub/dolt/releases/download/${DOLT_VERSION}/dolt-linux-amd64.tar.gz" | tar xz -C /tmp/doltdl
  sudo ln -sf /tmp/doltdl/dolt-linux-amd64/bin/dolt /usr/local/bin/dolt 2>/dev/null || ln -sf /tmp/doltdl/dolt-linux-amd64/bin/dolt "$HOME/.local/bin/dolt"
fi
dolt version
mkdir -p /tmp/iam-dolt && cd /tmp/iam-dolt
dolt config --global --add user.name poc >/dev/null 2>&1 || true
dolt config --global --add user.email poc@example.invalid >/dev/null 2>&1 || true
[ -d .dolt ] || dolt init --fun >/dev/null
if ! dolt sql -q "select count(*) from iam.assignments" >/dev/null 2>&1; then
  dolt sql < "$OLDPWD/data/demo/01-schema.sql"
fi
cd "$OLDPWD"
(cd core && cargo build -p iam-core --locked)
(cd apps/api && npm ci && npm run build)
(cd apps/web && npm ci)
echo "demo-setup: done. Start everything with: bash scripts/demo-start.sh"
