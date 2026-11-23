# Durable signup and workflow publication

Workspace/Dolt deployments select the unversioned `iam_meta.signup_requests` queue. Other configurations select a memory backend. Reads do not create storage. Queue writes use optimistic revisions; stale writers cannot resurrect consumed requests. The stored queue contains salted password hashes and hashed confirmation tokens, never the original password or token. It is sensitive operational state and must use the deployment's database access and backup controls. Public/admin projections exclude these hashes.

Workflow signup approval is a preparation, not publication:

1. Read an administrator-authorized request snapshot.
2. Resolve approve on an isolated workflow branch, in workspace mode. The queue reserves the request for that run BEFORE any directory effect. No roles, live approval event or live account-created event are granted by preparation.
3. Request reviewed publication with `lyam-request-publish`. Human review and merge remain mandatory. Branch abandonment leaves the request visible and reserved, not silently removed.
4. `lyam-finalize-signup` rereads main. Identity id, display name, email, login flag, credential revision and requested profile values must match the preparation. Only then does it record finalization and emit approval/account-created events. Another run cannot finalize this request.

Known boundaries:

- `holdAfterVerification` workflows refuse at preparation until publication-coupled activation is supported. The direct administrator approval path retains its existing hold behavior.
- A failure after reservation leaves a visible `preparing` state. No blind recreation is permitted. Operator reconciliation is required; automatic reservation release is deliberately absent.
- Finalization persists its tombstone before emitting events. A crash between those steps cannot repeat approval or recreate the account, but can miss events. This is NOT a transactional event outbox or an exactly-once event delivery guarantee.
- Finalization verifies effective main data, not an arbitrary external application's state. A settings change between preparation and publication still needs qualification.
- Queue CAS prevents stale queue replacement, not distributed transactions across the directory, local credential file, queue, block store and event bus. Direct administrator approval keeps its existing effect boundaries.
- Old in-memory requests from an already running release cannot be recovered after they have been lost. No historical request migration is invented.

Tests cover local real Dolt persistence, tenant isolation, stale writes, confirmation/rejection after new instances, preparation before publication, unchanged request visibility, another-run refusal, uncertain creation and finalization after the actual local review/merge path. They do not establish Oracle deployment or process-kill recovery.
