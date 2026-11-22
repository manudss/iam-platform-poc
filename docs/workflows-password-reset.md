# Approved password reset workflow: status and manual reconciliation

Status: **NOT READY as a secured path.** The server refuses activation and every real start of the approval-bound path. A core-owned engine barrier also stops old queued/running/waiting runs before provider resolution or any next step, including retries and boot recovery. There is no environment, plugin-setting, graph or request override. The editor may simulate it without effects. Existing effects from older runs are not reversed by this freeze. This page states what the template guarantees, what is proven, and what an operator does after an interruption. It is not a promise of end-to-end safety.

## Path

`propose` (approval task, admin pool, requester cannot decide) > `block` the account > `generate` the password (kept in memory only) > `apply` > `publish` > `mail` (demo outbox only) > `unblock` (only the block this run set).

## What the template enforces

- **Single approval claim.** `apply` claims the approval with one atomic conditional update on the task row (consumer id is `runId:nodeId`), writes the credential on the run branch, then records the effect with the credential revision. After the effect is recorded nobody can claim again, the same node included.
- **Revision binding.** `publish` and `mail` accept only the revision recorded by this run's `apply`. A publish after an apply node in the graph must carry the reset guard (approval task, account, validity, revision), even when apply failed or runs in parallel.
- **Non-admin target, fail closed.** "Administrator" means the server setting `IAM_API_ADMIN_SUBJECTS`, read at each call. It is not an IAM role and not the admin token. An empty list refuses the reset.
- **Guard re-run inside the publication queue**, right before the merge (not atomic with the merge itself).

The generic `set-temporary-password` block is outside this path on purpose: it stays usable without approval (badge flow) and gets none of these guarantees.

## What is proven

Real Dolt, one server, one API process, activation and registries stubbed where noted:
claim concurrency (12 connections, one winner); claim and applied recording survive a killed process; publisher resumes the same head after a kill before the merge and after the merge before activation is recorded, without a second merge. Doubles remain for the full engine run, the mail client and the real activation service.

## Not proven

Several API processes; a kill in the middle of a real Dolt merge; the real activation service after a kill; a real mail provider; atomicity between the guard re-check and the merge; a kill between the credential write and recording it on the real service (the replay would write the credential again, a new revision, proven only in-process).

## After an interruption (manual)

| Observed | What it means | What to do |
| --- | --- | --- |
| Run failed or waiting, approval consumed, no applied revision | Claim done, effect not recorded. Another node or run is refused. | The frozen workflow cannot resume, even on the same node. Inspect the recorded state; recovery needs a separately approved and qualified manual path. |
| Credential on the run branch, nothing published | Versioned, not live. | Inspect or discard the branch. Do not use the frozen workflow to publish an unfinished reset. |
| Data merged on main, activation not recorded | The new credential may already be live while the account is still blocked. | Inspect the actual main/activation/credential receipts with the operator. The frozen workflow cannot be used as an automatic recovery path. |
| Run restarted after a crash | The generated password lived in memory and is gone. No mail can be sent. | Do not reuse the old credential or retry the frozen path. Use separately approved manual recovery after checking the account state. |
| Account stays blocked | Unblock only runs at the end of the path. | An administrator lifts the block that this run set, after checking the credential state. |

No step above needs a secret in a ticket, a log or this page.

## Exposure and delivery boundary

The block catalogue and official template remain visible to workflow administrators for inspection and effect-free editor tests. Workflow routes require AuthGuard, AdminGuard and the workflows-iga enabled guard. `workflow-connectors` supplies the blocks through its catalogue entrypoint; enabling or granting that provider does not remove the core freeze. This is not a UI-only hide and does not depend on the provider being disabled.

Detection covers the proposal/apply block types anywhere in the stored graph (including disconnected, error or parallel paths), plus reset-bound publish/secret-mail configuration. Generic `lyam-set-temporary-password` and the badge flow remain outside this path and do not acquire a new approval requirement. A privileged operator could still perform separate manual account operations; this freeze makes no claim to forbid those unrelated tools.

Delivery is cumulative against main so the authority and live-target corrections land in the same merge as the new IGA operations, never as a vulnerable intermediate state. This does not make reset ready: its server execution remains refused.

Simulation boundary: the official full template currently stops on the simulated proposal output missing its subject field. It does not create a task, branch, block, credential, publication or mail. Every downstream effect block is separately tested with test:true and effect dependencies that reject any real call. Test mode is not a way to execute the frozen reset. The freeze recognizes the documented types and binding fields, not an arbitrary newly installed third-party block, and does not cancel effects already in flight on older code.

Automatic trigger boundary: permanent RESET_FROZEN refusals are logged and skipped per event definition, so they do not keep the event unacknowledged or starve later definitions. Other errors keep normal redelivery semantics. The cron loop already catches each definition separately and releases its tick lock; both loop behaviors are tested with controlled dependencies.
