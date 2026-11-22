# Workflow admin blocks: coverage and evidence

This is a traceability matrix, not a production-readiness claim. Evidence: **block** means catalogue presence; **double** means controlled dependencies; **piece fixture** runs the installed Activepieces action against a local fake HTTP server or nock fixture; **Dolt integration** uses real Dolt, durable workflow store, engine and application bus. HTTP authentication in the workflow integration suite is faked; the real AdminGuard remains active. No live Jira/Google account was called.

## Fourteen families

| ID / family | Implementation | Evidence and limits |
|---|---|---|
| F1 Reads | User/search, role, assignment, organization, application, authn, profile schema, run projections | `admin-blocks`, `reads`, `workflows.e2e`; persisted workflow reads omit profile/email by default |
| F2 Users and profiles | Create/update, login enablement, profile field; read/resolve signup and self-profile review | `intake` adapter doubles and actual ProfileService serialization; `workflows.e2e` verifies signup approve is refused before branch creation, request deletion, approval/directory call or account event. **Gap: signup approval needs publication-aware request finalization**; in-memory pending requests are not restart-durable. Profile resolution is immediate. Snapshot/self-edit serialization is single-process, not distributed |
| F3 Roles and assignments | Create/update, grant/revoke, simulation, explicit current SoD conflicts, removal proposal | `admin-blocks`, `workflows.e2e`; branch writes and SoD simulation, not automatic publication |
| F4 Organizations | Create/assign, impact, member removal, removal proposal | block + double |
| F5 Approvals and tasks | Request, inbox, decision, delegation, overdue/reassignment, anti-self-approval | `tasks-service`, `task-consume-dolt`, `iga-escalation`, `workflows.e2e`; validated caller and current active target. Pool aliases currently choose their first member for target validation; a disabled first member blocks the alias even when another member is active |
| F6 Publication | Diff, publication request, publisher precheck, human merge | `workflows.e2e`, `publish-*`; real Dolt/publisher with activation registries stubbed. Not a live deployment |
| F7 Applications | Create, enablement, role binding, removal proposal | block + double |
| F8 Authentication | Read policies/enrollments, policy proposal, re-enrollment request, first access | block + double. Re-enrollment is immediate and not versioned; demo outbox only. Secured password-reset path remains NOT READY and server-frozen before the first step, including activation/start, old queued runs, retry and boot recovery; generic temporary-password block is unchanged |
| F9 Policies | Validate, propose changes | block + double |
| F10 Plugins, mail and theme | Read state, propose plugin/settings, mail template/theme read/preview/proposal | block + double. No permission to install arbitrary code |
| F11 Imports and external connectors | CSV/SCIM; bounded group connection probes; Sheets read/add/update/find rows/create column; Jira create/search/get/update/comment/transition | `google-sheets-contract`, `jira-actions`, `sheet-create-column`; actual installed pieces on local fixtures, not live accounts. Existing Sheets update-row reuses `update_row`. Jira update verifies returned fields; external effects stop for review when uncertain. Labels replace the Jira label list, so omitting a watcher label removes it and can stop watcher matching. Column precheck is not a lock against concurrent header creation |
| F12 Sub-workflows | Start/read child; bounded await | `admin-blocks`; wait polls up to 120 seconds, fails on failed/canceled/timeout, polls a human-waiting child until timeout. Not a durable asynchronous child join; restarting starts polling again |
| F13 Delegations | List/revoke request; bounded agent-access proposal | `admin-blocks`; proposal requires exact tool scope, beneficiary, upstream delegation and future expiry within 24 hours. Proposal only: no grant, secret or automatic activation |
| F14 IGA recertification | Campaign, reviews, delayed escalation, decisions, prepared removal, closure/evidence | Six steps and five criteria below |

Error-route notification can use the existing error edge and notification blocks. The generic notification is simulated, and workflow mail uses the demo outbox; no real delivery claim is made.

## IGA: six steps

| Step | Implementation | Evidence |
|---|---|---|
| 1 Freeze scope | `iga-create-campaign`, up to 200 items, Lyam roles only | `workflows.e2e`: keep, prepare revoke, reject, removed and absent-manager campaigns on real Dolt |
| 2 List items | `iga-list-items`, minimal projections | double + Dolt integration |
| 3 Open reviews | `iga-open-review-tasks`, bounded deadline, explicit escalation target; unknown/disabled manager routes to pool, read outage fails rather than being treated as absent | `iga-escalation`, `workflows.e2e` |
| 4 Collect decisions | `iga-await-decisions`, durable open tasks, anti-self-review, caller-authorized reassignment | `tasks-service`, `workflows.e2e`: delayed review stays visible, escalates once, authorized pool decision resumes campaign |
| 5 Prepare and confirm remediation | Snapshot access recheck during preparation, again immediately before prepared branch revocation; mark-remediated rejects remaining snapshot roles and newly appeared roles | `iga-escalation`, `iga-mark-remediated`, `workflows.e2e`. The action-time check is not atomic with a later human branch merge |
| 6 Close with evidence | Campaign summary/digest, unresolved removals remain visible, explicit authorized exceptions | double + complete real-Dolt campaigns in `workflows.e2e` |

A rejected escalation remains with its current decider, records an escalationError and is marked reminded; the automatic escalation is not retried. A manual authorized reassignment is needed. Missing login_enabled is refused fail-closed for replacement/escalation targets. Delays never choose retain/revoke automatically. No automatic reconciliation, unlock, external-right review or multilevel extension is added.

## Five acceptance criteria

| Criterion | Concrete test / proof | Remaining boundary |
|---|---|---|
| Restart without loss | `workflows.e2e`: waiting IGA campaign, stop/recreate Nest app, same task, no duplicate, decision resumes and closes; `task-consume-dolt`: crash/claim consumption | Local single-process restart, not distributed failover |
| Validator in scope, no conflict of interest | `tasks-service` + `iga-escalation`; real engine refuses unauthorized starter, legacy route refuses too; deadline validates active target on main; real delayed campaign decides through admin pool | Authn mocked in integration, real AdminGuard |
| Access changed after launch detected | `iga-escalation`: snapshot mismatch before preparation and action-time check; `iga-mark-remediated`: newly appeared roles, including initially empty snapshot | No atomic guarantee covering a future human merge |
| Refused or unknown removal stays visible | `iga-mark-remediated` doubles; `workflows.e2e` refused/removed/exception closure paths | Full external entitlement reconciliation is outside this increment |
| Test run without real effects | `admin-blocks`, `execution-safety`, `workflows.e2e`: test/dry no-op, no grant/revoke data branch for retained/delayed campaigns; fixture-only connector calls | A fixture test is not evidence of live provider delivery |

## Operational boundaries

Run-branch changes still need review/publication. Immediate profile resolution, rejection, factor changes and notifications are not undone by discarding a branch. Intake effects record an uncertainty marker before calling the business service; a crash requires review, not blind replay. Pending signup requests and the profile serialization lock are local to one API process. Long-lived child waiting, multi-replica intake coordination, live provider verification, and the secured reset path are not claimed complete.

## Current validation checkpoint

TypeScript compilation passed. The latest selected run finished with a clean exit: **193 tests passed, zero failures, zero skips**, including the full 38-scenario workflow integration suite on real Dolt and the real application bus. Earlier bounded invocations that timed out are not counted as passing. The selected 44-suite rerun exited cleanly in 97 seconds. These are selected local suites, not a claim that all repository CI is green.

Signup approval is explicitly refused before effects until publication-aware request finalization exists. Its negative integration test verifies no branch, pending request retained, no SignupService.approve call, and no account/approval event for the subject. Other intake paths remain immediate, single-process operations as described above. CI must still validate the exact published head. The main-branch cancellation and Gallery bootstrap repairs are separate changes, not silently included here. Delivery is cumulative against main, never through the superseded intermediate PR states.

Reset simulation is effect-free but not functionally complete: the full official template currently stops on a missing `subject` in the simulated proposal output. The negative engine test verifies no task/branch/account/credential/publication/mail effect. Independent real-block tests exercise each later effect block with `test:true` and effect dependencies that throw on any use, including runtime Real flags; schema validation separately refuses unsupported execution-mode override fields. Managed Jira Real-mode editor simulation is covered by execution-safety. Trigger-loop tests use controlled dependencies: permanent RESET_FROZEN is logged and skipped so event delivery continues to other definitions; unrelated errors still reject for redelivery. Cron already isolates each definition and releases its tick lock. This is not a new real-bus outage/failover qualification.
