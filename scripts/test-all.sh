#!/usr/bin/env bash
# One command for every test that needs no running service. Browser end-to-end checks (scripts/*-e2e.mjs) need Dolt, NATS, Chrome
# and the built core: set DOLT_BIN, CHROME_BIN, NATS_SERVER_BIN and add E2E=1 to run the authentication one too.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== API unit tests"; (cd apps/api && npx tsc -p tsconfig.json && npm test)
echo "== SSO session integration"; node --test scripts/sso-session.test.mjs
echo "== Web unit tests"; (cd apps/web && npm test -- --watch=false)
echo "== Demo edge tests"; node --test demo/frame-policy.test.mjs demo/public-redirect-uris.test.mjs
if [ "${E2E:-}" = "1" ]; then echo "== Authentication methods e2e"; node scripts/auth-methods-e2e.mjs; fi
echo "ALL TESTS PASSED"
