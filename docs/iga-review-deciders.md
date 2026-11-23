# IGA review deciders: local qualification scope

This change extends only the pending IGA review path. It is not a deployment, a live-provider result, or completion of the wider admin/IGA work.

## Rules

- An IGA pool assignment selects the first configured eligible member, not simply the first string. The member must exist on main, have `loginEnabled === true`, and not be the reviewed person. Missing or disabled members are skipped. An unavailable read stops selection. A concrete target is never silently replaced.
- A campaign records its manager snapshot. Opening a manager-assigned task re-reads the reviewed person's current manager on main and validates that manager. The snapshot is evidence, not continuing authority.
- A newly manager-bound review refuses a decision when the current manager differs from the manager recorded at assignment. It does not silently move the task. An already authorized admin/IGA workflow starter can explicitly request `iga-reassign-review` with `to: "manager"`. That keyword resolves the current manager separately for each reviewed person. It does not grant admin/IGA membership to the manager. For this workflow-initiated replacement, arbitrary concrete IDs still require admin/IGA membership. This is different from the existing delegation endpoint: a current authorized review owner (or admin/pool actor) may explicitly delegate to an active non-beneficiary user outside those pools. Delegation removes the manager binding and records an explicit ownership transfer; it is not a promise that only managers/pool members can ever decide a delegated review.
- Review delegation and reassignment transfer the current owner instead of adding another OR-authorized owner. The task ID, item, run, deadline and reminder timestamp stay intact. The assignment version and history are persisted with the owner in one SQL update.
- A decision compares the assignment snapshot it validated, including for admin/pool decisions. A concurrent reassignment invalidates the old decision write. A decision that wins first prevents a late reassignment from rewriting its owner or audit. Two moves of the same assignment have at most one winner. Assignment versions also reject A-to-B-to-A stale snapshots.
- An IGA decision requires a currently active directory identity, including pool/admin actors. Existing anti-self-review and starter-chain restrictions remain in force. Generic approvals and the secured reset freeze are unchanged.
- Deadline escalation uses the same active-member selection and ownership-transfer operation. A rejected escalation remains visible with the existing decider; no retain/revoke decision is inferred from a deadline. An unavailable storage write is not presented as a successful move.

## Evidence

`iga-active-review.spec.ts` tests controlled live-read responses and refusal before a task is written. `iga-review-ownership-dolt.spec.ts` uses a real isolated Dolt server, real main-directory reads, the real workflow task store/services and real campaign creation. It covers manager changes, explicit reassignment, former-owner refusal, delegation, inactive actors, both decision/move orderings, competing SQL moves, stale error annotation and reconstruction of services over the same persisted store. No external account is called.

`workflows.e2e.spec.ts` exercises the real workflow engine, local bus and Dolt: campaign creation, manager task, directory manager change, refusal of an old decision, explicit replacement through the actual workflow block, the new manager's decision, original-run resumption and closure. Its HTTP authentication remains a test guard; the real AdminGuard remains active. The existing application-restart and other recertification journeys are retained. The fixture now creates actual active directory identities for its named pool actors instead of relying on authentication-only names.

Build and selected local runs are recorded in the PR. These do not substitute for exact-head CI or independent review.

## Boundaries kept open

- The directory read and the subsequent meta-store decision are not one transaction. This change detects drift observed by the check and assignment changes racing the SQL write. It does not guarantee serialization against an unrelated concurrent manager/login/membership update after that read.
- Old tasks without manager-assignment provenance are not silently adopted or backfilled as manager-bound tasks. An old manager-assigned task without that provenance can still be decided by its old owner after a manager change until it is explicitly reassigned. Only the new/reassigned manager-bound tasks have the manager-drift check. This is a known legacy boundary, not a retroactive manager guarantee. Generic approvals keep their existing delegation semantics.
- Reconstructing services over a live local Dolt server is not a cold database/host restart or distributed-failover proof. The separate application-restart test covers the stated local application lifecycle only.
- This does not complete signup publication-aware finalization/durability, durable asynchronous child joins, the secured reset path, all admin-family authorization/validation parity, full external entitlement reconciliation, live provider verification, or evidence-retention policy. It does not change authentication PRs, deployment pause/queue state, main, or any remote account.

## Proposed legacy-task triage (procedure only, not run in production)

1. An authorized operator inventories open IGA reviews without `reviewManager` using an owner-approved read of the meta-store. For example, on the meta database:

```sql
select id, tenant, run_id, node_id, assignee, delegated_to, detail
from workflow_tasks
where kind = 'iga-review' and status = 'open'
  and JSON_EXTRACT(detail, '$.reviewManager') is null;
```

2. Keep that result private. Missing provenance does not imply manager assignment: explicit pool/delegated reviews intentionally lack it. Correlate the task's campaign/item/run with the original assignment configuration and applicable policy. Do not guess or bulk-backfill a manager from the snapshot.
3. If the task was intended to follow the current manager, have an already authorized admin/IGA actor review the live manager and explicitly request the existing replacement block with the campaign, former effective owner, reason and `to: "manager"`. That request changes task ownership and needs the operator's execution authority; this procedure does not authorize running it. The operation may report individual refusals, which must remain visible.
4. Read back each affected task: same task/item/run/deadline, new eligible owner, new manager binding and assignment history. Keep refused/unknown cases open for review. A restarted/replayed request alone does not add the binding.

No production inventory, reassignment, bulk data update or old-task backfill was performed for this qualification.
