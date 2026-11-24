# Native Activepieces Google Sheets integration

Work in progress. Not a production-complete or live-tested delivery yet.

The installed version is `@activepieces/piece-google-sheets` 0.19.5. Its runtime
catalogue contains 61 actions: 27 human-facing actions and 34 API/AI-input
variants, plus four triggers. The public integration page lists 27 actions and
four triggers: https://www.activepieces.com/pieces/google-sheets . The checked-in
inventory records native keys instead of assuming the public page is exhaustive.

The catalogue is generated from the installed package, preserving property keys
and delegating execution to its actual action and trigger functions. No email,
HR, badge or Done-status rule is embedded. Dropdown identifiers can be entered;
the authenticated property resolver invokes native dropdown/dynamic property
functions. JSON inputs retain the native resolved shape, not an alternative
business schema. The UI exposes property-resolution results for inspection.
Native results are returned as `result`; they are not flattened or renamed.

## Lyam host services, not Activepieces guarantees

- Managed write-only credentials and explicit Real confirmation. Simulation makes
  no provider calls. The full catalogue needs an explicitly account-scoped Google
  connection, because it can create/search/copy documents outside one legacy
  bound spreadsheet. Broadening a saved connection needs its secret entered again;
  old seals remain valid and old graphs keep their behavior.
- Private file bytes and native state are stored in the operational meta database,
  isolated by tenant and workflow/node (state) or run (files). Export downloads
  require an authenticated administrator and matching tenant/run. File limit 8MB.
- Native mutations and cursor-advancing actions persist an uncertain-effect
  marker before invocation. A lost response requires review, not automatic replay.
- Native trigger cursors and pending deliveries are durable. Polls stage cursor
  changes and events in one envelope; interrupted application can be recovered.
  Workflow event IDs deduplicate replayed deliveries.
- Google row webhooks use the native Drive watch/renew/stop lifecycle, a random
  route token and matching Google channel/resource IDs. HTTPS public base URL is
  required via IAM_PUBLIC_BASE_URL or PUBLIC_BASE_URL. Renewal is checked every
  minute after twelve hours. Uncertain enable/renew/disable remains in review;
  no automatic second registration is attempted.
- Custom API calls are limited to HTTPS sheets.googleapis.com/v4, no redirects
  or caller-controlled authentication headers. This is a documented credential
  boundary, not an upstream capability claim.

No row lock, compare-and-swap, value CAS or transaction across Google and Lyam is
provided. Native Update Row remains positional and USER_ENTERED. The optional
checked cell wrapper in PR163 is a separate Lyam guard, not a native action and
not a prerequisite of a native workflow. Demo rules belong in graph conditions,
searches, transformations and native action parameters.

## Qualification still required

Tests cover exhaustive registration/dispatch with action doubles, representative
installed native read/poll/webhook lifecycle/dynamic-field contracts over
intercepted Google HTTP, and real local Dolt persistence/recreation and tenant
isolation. None proves a live Google account, all61 real provider actions, a
live callback route or a multi-replica scheduler. Browser UI inspection, broader
regression tests and lifecycle/recovery review remain before a ready verdict.
A file in the catalogue is not evidence of complete functionality.

## Operations and remaining recovery UI

Set `IAM_ACTIVEPIECES_API_BASE_URL` to the externally reachable API root, including
`/api` when an edge proxy routes the API under that prefix. Existing
`IAM_PUBLIC_BASE_URL` / `PUBLIC_BASE_URL` are fallbacks and must already name the
API root, not merely a front-end origin. Callback setup is not live-qualified.

Trigger delivery uses a database mutex across application instances. Action
runtime state uses the same durable mutex per definition/node. The mutex does
not expire: after a process crash, calls stop rather than overlap an uncertain
provider call. Before releasing a stranded `lyam:lock`, an operator must stop
the former worker and reconcile provider effects and subscription channels.
The Connections page exposes a read-only runtime status panel: subscription
status, retained mutex and pending delivery count, with operator recovery guidance.
It never exposes webhook tokens, native state, payloads or lock owners and has no
unsafe clear/retry button. Recovery remains an operator procedure, not an
automatic unlock. Live callback delivery and representative account effects
still require qualification before a production-ready verdict.
The last reviewed state of this branch has no live credentials, registration,
workflow activation or Google changes performed by the development task.

## Storage migration and delivery limits

Migration0003 creates workflow_piece_state in the operational meta DB before
native runtime writes. Runtime writes no longer create this table lazily.
Existing migration0001/0002 files/checksums are unchanged. An old image refuses
an advanced migration journal: image-only rollback is NOT supported. Before
migration the operator must take and verify a complete coherent backup of the
business DB, operational meta DB including the journal, exports and operational
state. Qualification must explicitly review the additive Dolt metadata delta;
no deployment is allowed without that qualification and backup.

If boot stops with migration0003 pending, stop all workers and provider callbacks,
inspect the journal and table/primary key, and preserve uncertain-effect state.
The operator must either complete and verify this same migration under the new
image or restore the complete pre-migration backup and matching old image.
Never delete just the journal entry or table to force boot. A full restoration
can rewind cursors/effects, so reconcile provider effects/subscriptions before
reactivation. Never clear a mutex or auto-resume the queue as rollback cleanup.

Verified webhooks are durably coalesced to one notification slot per definition
before acknowledgement; the slot carries channel/resource/message-number and
allowed change headers, no body/token. At most1000 slots per tenant, guarded by
an autocommitted durable per-tenant mutex (scope inbox-quota). A crashed enqueue owner leaves that mutex for operator reconciliation; it is visible in runtime status and never expires automatically. Concurrent attempts fail503 rather than overlap. Conflicts or
quota exhaustion fail rather than acknowledge acceptance. At quota a new
notification is NOT durably stored and may be lost if Google does not retry.
A persistent per-definition review status records rejection when storage is available. An HTTP failure is not a delivery guarantee. Operators must monitor callback
errors, drain/reconcile retained slots, then explicitly refetch affected sheets;
do not assume replay of intermediate changes. Under its mutex the
scheduler performs at most one full native refetch per pass and deletes only
the exact slot value read before collection. A replacement during collection
survives. Native cursors and pending event envelope preserve delivery recovery.
A collection failure retains the slot and sets visible review status.

The scheduler ticks every60seconds, in addition to the upstream documented
Google delay up to3minutes. This is not a sub-minute arrival guarantee. Google
message numbers identify notifications, not an assumed sort order. Coalescence
is appropriate because native run refetches the current sheet; transient
intermediate cell values between refetches are not a change-event log.

New exported file bytes expire after7days; downloads refuse expired entries and
scheduler cleanup deletes only explicitly expired file scopes. Legacy exports
without expiry are retained. Trigger/action state, cursors, locks, pending work
and uncertain subscriptions have no automatic expiry: an operator must reconcile
them, never purge a lock as retention housekeeping. Account scope is an explicit
user-intent/configuration gate, not a narrower Google OAuth permission boundary.
The service account's actual grants remain authoritative.

Proof scope: the crash test injects an exception between collection and inbox
delete using doubles. It is not an operating-system process kill or live Google
crash/restart test. Native event recursion is limited to Sheets configs; other
blocks retain top-level-only event substitution (nested objects are unchanged).

Google Drive push reference checked:
https://developers.google.com/workspace/drive/api/guides/push
The current official guide lists success 200/201/202/204/102 and describes
exponential-backoff retries for 500/502/503/504 with its API client-library
condition. This receiver sends 503 for storage/quota/transaction failures and
404 only for rejected subscription credentials/parameters. Actual retry timing
and delivery remain unqualified for this deployment, never a lossless promise.
File cleanup is hourly (downloads still check expiry on each request).

Persisted run graphs carry reversible event encoding until step resolution, not
a display value. Run-detail/list responses omit that internal graph; pending
steps have no input, executed steps record their resolved input. Dry-run preview
decodes literals without evaluating step placeholders. Definitions are unchanged.
Raw operational DB backups retain encoded graph bytes for exact recovery.

## Retained native state and trigger edits
Configuration changes, retirement to manual, deletion/recreation and disable/re-enable
(including the tenant plugin) retain a review tombstone. Old cursors, pending events
and batch envelopes are preserved, never reused in a changed graph or automatically
purged. Residual state without a subscription also blocks activation. Provider is
in the fingerprint, so legacy fingerprints require review. This is an intentional
product limitation: no automatic reactivation/unlock is provided. Operators must
reconcile provider channels, cursors and pending deliveries before deliberate
recovery. A review tombstone does not prove the remote channel has stopped.
