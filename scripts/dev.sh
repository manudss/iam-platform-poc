#!/usr/bin/env bash
# Start the full Lyam (iam-platform-poc) local development stack with ONE command.
# Only prerequisite: Docker Engine with the compose plugin (Docker Desktop on macOS).
# No Node, no Rust on the host. Everything runs in containers with the sources mounted:
# saving a file reloads the console (4200) and recompiles/restarts the API.
# Console: http://localhost:4200 - sign in as demo-alice / demo-only-not-a-secret (fictional).
# First start compiles the Rust core inside its container (several minutes), then it is cached.
# Ctrl+C stops the stack. --down stops it, --down --volumes also deletes the data (re-seeded).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is not installed. It is the ONLY prerequisite for this path:' >&2
  echo '  macOS:  install Docker Desktop (https://www.docker.com/products/docker-desktop/)' >&2
  echo '  Linux:  install Docker Engine + the compose plugin (https://docs.docker.com/engine/install/)' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'The "docker compose" plugin (v2) is missing: https://docs.docker.com/compose/install/' >&2
  exit 1
fi
tries=0
until docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
  tries=$((tries + 1)); [ "$tries" -gt 24 ] && { echo 'The Docker engine is not running: start it, then re-run.' >&2; exit 1; }
  [ "$tries" -eq 1 ] && echo 'Waiting for the Docker engine...'
  sleep 5
done

[ -f .env ] || { cp .env.example .env; echo 'Created .env from .env.example (local placeholder passwords, documented, protect nothing).'; }

compose=(docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml)
case "${1:-}" in
  --down)
    shift
    if [ "${1:-}" = '--volumes' ]; then "${compose[@]}" down -v; else "${compose[@]}" down; fi
    exit $?
    ;;
esac

echo ''
echo 'Starting the Lyam dev stack (first start: Rust build + npm installs, several minutes).'
echo 'When the log shows the console is ready: http://localhost:4200'
echo 'Sign in: demo-alice / demo-only-not-a-secret (fictional local data).'
echo 'Ctrl+C stops everything. To reset the data later: scripts/dev.sh --down --volumes'
echo ''
exec "${compose[@]}" up --build
