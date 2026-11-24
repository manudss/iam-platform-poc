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
