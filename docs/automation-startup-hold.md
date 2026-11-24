# Explicit startup hold for workflow qualification

Base: TLS-only PR166 b7dd102ed7753ad4d72538ff4e768896cb4a8b7f. This does not depend on the catalogue cutover in PR165/167.

## Startup contract

IAM_AUTOMATION_HOLD absent preserves existing behavior. The exact value 1 holds automation. Every other present value, including empty, whitespace, 0 and false, refuses startup. The setting is captured once before Nest creates services. Changing the process environment afterwards does not release or enable the hold. Startup logs report the effective captured held/settingPresent state. The operator must verify this effective output before qualification, not only a configuration file or frontend response.

Restarting without the hold is not neutral. Retained runs, child waits, durable trigger deliveries, activation journal catch-up and reconciliation can execute on that restart. Inspect and reconcile that backlog first under the separate authorization for effects. Removing the hold is never that authorization. Do not delete KV, markers or runs, or create replacement workflow IDs to bypass deduplication.

Qualification starts on an isolated coherent copy, provider egress closed, without production writable storage or credentials. No production boot, merge, deployment or resumption is authorized by this change. No zero-write or globally side-effect-free startup is claimed.

## Protected entries

| Entry | Held behavior |
| --- | --- |
| Engine boot recovery, retry recovery, child-wait scan | Return before store reads, writes, failure markers or engine resolution |
| Engine delegate/kick, selected plugin engine and child-start dependency | Refuse or no-op before plugin execution or run creation, including mail/non-managed actions |
| Cron init/tick, overdue task scan, Sheets/Jira poller init/tick | No timers, provider polling, cron markers, task writes or run starts |
| Durable workflow trigger consumer | Not registered while held; direct dispatch refuses before processing |
| Public webhook POST | 503 before token/config/run handling |
| Workflow/controller non-read methods | 503 through enabled guard, plus service barriers before durable mutations |
| Task decisions/delegation and task write dependencies | 503 before writes or kicks |
| Managed connection mutation/test/probe/resolve | 503 before credential lookup, provider probe or stored test result |
| EffectsService startup | No pool, activation-effects consumer or journal catch-up |
| MainPublication startup | No core-version fetch or automatic activation, including before migration readiness release |
| Activation background initialization/tick | No timer or automatic journal reconciliation |

Workflow mutation service coverage: save, saveTemplate, removeTemplate, remove, setActive, removeRun, start, testRun, rerunFrom, duplicate, retry, cancel, review. Task coverage: request, consume, markApplied, decide, delegate, reassignOpen, settleSystem, cancelForRun, scanOverdue.

## Routes inspected

All routes below use the tenant prefix. Non-read routes are held, including connection probes.

- Workflows: POST/GET workflows; GET/PUT/DELETE workflows/:id; POST workflows/test-run, workflows/:id/duplicate, workflows/:id/active, workflows/:id/runs.
- Templates: GET/POST workflow-templates; DELETE workflow-templates/:id.
- Runs: GET workflow-runs and workflow-runs/:runId; POST workflow-runs/:runId/rerun-from/:nodeId, retry, cancel, review; DELETE workflow-runs/:runId.
- Tasks: GET workflow-tasks; POST workflow-tasks/:id/decision and delegate.
- Connections: GET/POST workflow-connections; PUT/DELETE workflow-connections/:id; POST workflow-connections/probe and workflow-connections/:id/test.
- Public trigger: POST workflow-hooks/:definition/:token.
- GET workflow-blocks and workflows-events remain inspection routes.

GET list/get/templates/runView/inbox read stored state or static metadata. Connection GET exposes metadata/status text, not a live provider test. There is no workflow callback/status GET with execution behavior in this tree. The unexposed dryRun service method validates/substitutes/describes the graph; it does not execute blocks or persist a run. Lazy schema initialization reached by reads remains possible, as below.

## Explicitly outside this hold

| Area | Residual behavior and operator implication |
| --- | --- |
| Manual activation HTTP/core | Not blocked by this workflow hold. Direct activation/publish/core administrative requests can still change active permissions. Keep those routes inaccessible during qualification. |
| Bus-host notify/OTP handlers | General notify.send, authentication OTP and related mail handlers are not universally disabled. Avoid interactive sign-in/OTP flows, close provider egress, and control core/bus access separately. |
| Audit | Audit consumers may register, acknowledge events, create tables and persist decisions. This is not a universal bus pause. |
| Migrations | Normal boot migration/journal operations remain enabled by their existing settings and may write data/schema. Use only the approved migration plan on the isolated copy. |
| Demo seeds | Auth, demo data and workflow seed switches retain existing behavior. Migration mode has its own seeding flow. Inspect the effective operator configuration, do not assume hold suppresses seeds. |
| Users/credentials | User-service schema/credential initialization, login/session/credential activity remain outside the hold. |
| Branch protection | Startup loading can initialize its metadata database/table. |
| Auth/SSO | Authentication routes, sessions, enrollment, OTP and HTTP-request effects are not a read-only mode. |
| Registry/bus infrastructure | Startup connections, handlers, durable infrastructure and unrelated deliveries remain possible. Audit or other consumers are not held. |
| WorkflowStore reads | Existing lazy schema setup/migration can write on first access, including an inspection GET. Workflow operational execution markers are held, not every schema write. |
| Other API mutations | Non-workflow account/settings/data/core routes are not globally blocked. Frontend503 is not security isolation. |

The guarantee is limited to the enumerated workflow execution/mutation entries and the three automatic activation/effects paths. It is not zero durable writes, not a read-only server, and not absence of every external effect. Host isolation and network containment remain prerequisites for qualification. A reconciliation console and automatic state cleanup are explicitly not included.

## Local evidence and limits

The Map sentinel test proves no store/provider access at the held entries. It is not persistence evidence. The separate isolated Dolt fixture records queued/running/waiting runs, a queued child mail run, an open task and cron marker. Its held service startup plus controller GET handlers preserve the SQL working-root hash. A second subprocess over that same fixture without hold attempts provider resolution and records RESUME_FAILED review markers, proving the fixture distinguishes the states. Removing the boot or cron barrier is detected by the SQL-backed test's access assertion before the HTTP inspection reads. It does not require a provider effect to occur.

A bounded Nest HTTP fixture exercises actual workflow, tasks, connections and webhook routing, the real AdminGuard and WorkflowsEnabledGuard, but an explicit fictional AuthGuard override. It verifies401 then403 then503 for workflow writes, and public webhook503 without handler access. This is not a complete AppModule boot or real authentication/network-containment qualification. The SQL GET checks invoke real controller handlers rather than a full HTTP application. No host/container startup qualification has been performed.


## Isolated full-image qualification harness

`scripts/automation-hold-container-check.mjs` is called by the existing demo-docker CI job. It is a qualification harness, not an operator recovery command. It creates synthetic named volumes and containers only, with network none and no published ports. The first boot seeds fictional data. An offline Dolt fixture then retains queued/running/waiting runs including a child mail step, a human task, a cron marker and active cron/event/webhook definitions, plus a synthetic main change. The held reboot uses seed mode never. Workflow table contents and the core version are compared to the preboot fixture, then checked again after real HTTP probes and a scheduler interval. Other changed table names are recorded separately, not asserted globally empty.

The probes require the captured hold startup log, public webhook 503, real fictional-user PKCE sign-in, authenticated run-write 503 and run-list/health 200. A separate copy of the same stopped synthetic volume boots without hold and must show changed run state, cron marker and local core version. Direct API launch must reject invalid hold/TLS environment values with its own nonzero exit. A self-signed local server must be rejected by a separate Node process using its default TLS verification, with the dist environment guard imported. This does not prove the API process or native-piece TLS policy. This does not load native pieces, enumerate NATS consumers, inject an event-bus delivery, exercise PostgreSQL/Effects or qualify a production backlog. Provider delivery and UI are not proved. Image networking prevents external egress, not local writes. The harness has not been executed until a matching CI artifact records its result; source review and syntax checks alone are not a pass.

The harness runs after the existing Gallery checks so its first failure cannot skip them. Its unheld witness polls for run, cron-marker and core-version changes for at most90 seconds rather than relying on a fixed delay. Only structured startup/cron summaries are exported, after an in-container check against API environment secrets and bearer/JWT patterns; raw API logs are never copied to artifacts. Expected added CI time is6 to10 minutes, not measured locally; the existing45-minute job timeout is unchanged.

## Closed recovery preparation, separate from opening

The manual `update.sh --closed-recovery` path returns 10 only for CLOSED_QUALIFIED. It requires an existing update pause, an independent unchanged OPS maintenance marker, its own maintenance marker, a fresh explicit receipt, a mandatory preservation checker, and reviewed preflight and confined-launch helpers. Missing or conflicting conditions refuse before stopping the old container. The helpers must validate the exact image digest, migration manifest and existing final ledger before any application boot. They must never run migration prepare or the previous application to discover compatibility.

This mode never removes either gate or the pause. Every error after gating stops the application and preserves evidence without automatic old-image boot or destructive Dolt/PostgreSQL/Bao restore. Return 10 must not trigger the error-stop trap. Normal updater behavior is unchanged. The queue and host-boot never pass or accept the manual flag. A queue unexpectedly receiving return 10 records failed and does not advance delivery.

Use the actual manual caller `python3 deploy/oci/closed-recovery-call.py --updater /reviewed/update.sh --image EXACT_DIGEST --env-file /private/lyam.env --receipt /private/FRESH_RECEIPT`. Under an errexit shell capture safely with `rc=0; python3 ... || rc=$?`, then require exactly 10. Return 0 is not a closed-recovery success. The caller checks receipt identity, persistent host hold=1, public 503, real API health and captured held=true. It never resumes the queue or opens the service. This is an invocation contract, not authorization to run it.

Before preparation, the operator must persist IAM_AUTOMATION_HOLD=1 and seed mode never in the private host environment, separately from repository code. A confined candidate has restart=no, all capabilities dropped, no-new-privileges and an inert entrypoint on every container start. A reviewed helper installs and tests IPv4/IPv6 namespace policy before releasing its one-use startup gate. A later stop/start returns to inert waiting, never to application startup without new confinement checks. Local namespace/socket fixture results are not Docker or production-image proof. Real namespace identity, rules, companion reachability, blocked external/DNS traffic and runtime capabilities must be recorded before release and rechecked after API startup.

The held smoke still exercises real PKCE, session extension, activations and migration-ledger validation. It additionally requires captured hold and API health, and hashes all workflow tables before and after the smoke. Audit/session writes remain subject to the original exact preservation policy and any independently reviewed image-specific verifier, not a broad ignore list. The CI harness exercises session extension and activations with the existing workflow snapshots. No new head is qualified until its CI and artifacts pass.

Integration must add one coherent merge commit containing TLS, hold and closed-recovery changes to main. Do not put an intermediate TLS-only first-parent commit on main, because the deployment queue considers every first-parent commit. Preserve the qualification-control introduction commits and block unintended OCI and Render delivery before merging. The final merged SHA and immutable image, not a draft branch SHA, are the operator's inputs. Opening user access, lifting hold and resuming workflow effects are separate decisions.

### Recovery delivery suspension and failed-candidate evidence

The recovery integration deliberately suspends the production Render Actions job
with a constant false condition. The production delivery script also returns
`closed-recovery-suspended` before any network or credential use. Resume requires
an explicit reviewed code change after the suspension is closed. Existing queued
or running Actions jobs are not canceled by a future file change. Check image and
production delivery runs immediately before and after integration. Native Render
service source and auto-deploy settings must be observed separately; a workflow
guard does not disable native Git-backed auto-deploy.

A failed closed candidate is stopped and kept as evidence. The confined launcher
requires its container name to be absent. A second attempt can therefore be
blocked until an operator explicitly decides how to retain or remove the failed
candidate. Neither the caller nor the launcher removes it automatically.

`LYAM_CLOSED_IMPLEMENTATION` must name the installed Python helper, in addition
to launcher/preflight paths and the private reviewed `LYAM_CLOSED_CONFIG`. The
independent integrity check verifies all three hashes against that configuration
before any helper executes. Each path and ancestor must be owned by root and not
writable by group or others. The private receipt records all three hashes, which
the caller compares to its own pre-execution verification. Fixture-generated
hashes demonstrate consistency only, not operator review of production content.

The Docker helper fixture is a separate proof from the PKCE/held-AppModule
harness. The former uses the pushed immutable GHCR digest and complete confined
launcher on synthetic data and synthetic PG/Bao. The latter uses network none
and the same cap-drop, no-new-privileges, restart-no and FIFO guard. Neither uses
production data or authorizes opening, restoring state, lifting hold or advancing
the deployment queue. The final production configuration still needs the exact
image's reviewed manifest, start script, entrypoint and installed native bundles.

The temporary `render_state` CI job is recovery-branch-only and must be removed
before the final merge. Its exact SHA must be reviewed before each run with the
existing Render key. UNKNOWN, a Git-backed service, autoDeploy not explicitly no,
an unpinned image, or active deploys are not a clearance. A green observation
requires image runtime, no repository/branch source, autoDeploy no, an immutable
GHCR digest and no active deploys. Metadata is printed in the public CI log;
keys, headers, environment variables and response bodies are never exported.

The prior app container's inspect and logs are saved privately before it is
removed to free the candidate name. Those files may contain secrets and must not
be attached to a public artifact. The updater's launch proof and receipt are
private, root-controlled files. Live helper verification runs after held API
health and before preservation qualification, then again in the independent
caller. The receipt binds the IPv6 classification and raw-state hash to the
launch proof. No automatic destructive rollback follows a closed failure.

### Render merge side effects

The image workflow no longer moves `latest`. This freeze remains in force until
a separate reviewed change explicitly lifts it, including after OCI recovery. It still
publishes the exact commit SHA and the PR qualification tag and exposes the
immutable digest required by OCI. The production Render job remains hard
suspended. The temporary Render secret-reading CI job has been removed; its
read-only helper and versioned control remain without any workflow execution.

Observed service state was image runtime, autoDeploy no, no Git repository or
branch and no active deploys. Image identity remained unknown in the sanitized
observation. That is not an immutable-image qualification. Render does not
redeploy image-backed services when a registry tag changes, but a later restart
or rescheduling can pull their configured tag again. Freezing `latest` avoids
our merge changing the existing production tag. No Render service was modified.
Before integration, check no prior image or production deploy run is still
queued or active; a future guard cannot cancel an already-created run.
