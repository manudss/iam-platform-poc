#!/usr/bin/env bash
# Local development supervisor for the app container of infra/docker-compose.dev.yml.
# NOT for production. Builds and starts the Rust core, then runs the API dev runner
# (infra/dev/api-dev.mjs: install stamps, compile, watch-restart). The gate between them is
# loopback-only by design, hence one container. If either process dies, the container stops
# loudly (a half-dead dev stack is worse than a clear restart).
set -euo pipefail

echo '[app-dev] waiting for nats:4222 and dolt:3306'
until (echo > /dev/tcp/nats/4222) 2>/dev/null; do sleep 0.5; done
until (echo > /dev/tcp/dolt/3306) 2>/dev/null; do sleep 0.5; done

cd /repo/core
echo '[app-dev] building the Rust core (cached in the dev-core-target volume; only the first build is slow)'
cargo build -p iam-core --locked

echo '[app-dev] starting iam-core'
./target/debug/iam-core &
CORE_PID=$!

cd /repo
node infra/dev/api-dev.mjs &
API_PID=$!

trap 'kill "$CORE_PID" "$API_PID" 2>/dev/null || true; wait 2>/dev/null; exit 0' TERM INT
wait -n "$CORE_PID" "$API_PID"
echo '[app-dev] FATAL: a component exited (see its output above); stopping the app container' >&2
kill "$CORE_PID" "$API_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
