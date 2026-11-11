# Workflow Connections

Implementation in progress. The backend is implemented; the Connections screen and action panel are in progress from the confirmed reconstructed design boards in `docs/design/workflow-connections/`. These boards contain illustrative states, not verified accounts. Editor C (#84) is a separate PR and must reach main before UI integration.

## Security model

- `workflow_connections` contains tenant-scoped metadata and an opaque credential reference only. Metadata is versioned on the selected Dolt data branch and reviewed like workflow definitions.
- Credentials are written directly to OpenBao KV v2. Each credential rotation uses a new UUID revision, created with CAS 0. A branch edit cannot overwrite a secret used by another branch or older metadata revision. Old revisions remain available for version rollback; this change does not garbage-collect secrets still referenced by history.
- No plaintext fallback. Without `IAM_BAO_ADDR` and `IAM_BAO_TOKEN`, credential writes and authenticated real actions fail closed. The deployment must supply a restricted OpenBao policy for `secret/data/iam/workflow-connections/*`, not a production root token. This PR does not deploy OpenBao or obtain third-party credentials.
- Responses never return credentials or vault paths. Stored metadata cannot name another tenant's secret namespace. Errors and known secrets in logs/outputs are redacted before persistence.
- Prior spike credential settings are removed from the plugin form. Existing historical plaintext values are **not** erased by this code change; rotate any credentials previously put in those settings. New credentials belong in Connections only.

## Actions and tests

External Google Sheets, Jira and HTTP actions default to `executionMode: simulation`. Real requires `connectionId`, `executionMode: real` and `realConfirmed: true`, validated server-side. Legacy graphs without these fields stay simulated. Existing computed text/logic blocks still compute. lyam data writes retain their isolated run-branch behavior.

Editor test runs always simulate external actions, even if a submitted graph requests Real. Simulated Sheets actions do not mutate even the demo sheet. A real Google sheet watcher resolves a managed connection from live main; legacy plugin credentials no longer drive polling.

HTTP uses an HTTPS-only, public-address-pinned transport. Redirects, URL credentials, custom ports, private/link-local/loopback targets and HTTP credential headers in an action are refused. The action URL must stay within its selected connection origin and slash-delimited path scope. The managed bearer token is only attached by the transport caller.

`POST /tenants/:tenant/workflow-connections/probe` tests unsaved form fields in memory without a credential write. It may reuse an unchanged secret from an existing same-tenant/provider connection id. `POST /tenants/:tenant/workflow-connections/:id/test` is an explicit read-only check: Jira reads the current account, Google reads configured sheet rows, HTTP sends HEAD. It returns status/revision/time, never provider response contents. A success is only the observed result of that check, not a permanent promise of access.

Before a non-idempotent external creation or HTTP mutation, the runner persists `EXTERNAL_EFFECT_REVIEW_REQUIRED`. A returned action and its output are persisted as done together with clearing the marker. If the call fails or the process restarts before completion is recorded, the run stops for review. Retry, rerun and error-route continuation cannot bypass that marker. Reconcile at the provider and author a new deliberate run instead of blindly duplicating the effect.

## Verification

Focused tests exercise real Dolt metadata/branch isolation, real OpenBao immutable revisions, model validation, default Simulation, forced editor Simulation, uncertainty/restart handling and secret redaction. They do not call Google/Jira accounts.

```sh
node scripts/plugin-deps.mjs
node scripts/plugin-dev-setup.mjs
cd apps/api
npx tsc -p tsconfig.json
DOLT_BIN=/path/to/dolt BAO_BIN=/path/to/bao node --test dist/workflows/connections*.spec.js dist/workflows/connection-secrets.spec.js dist/workflows/http-transport.spec.js dist/workflows/execution-safety.spec.js
```
