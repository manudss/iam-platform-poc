# Approved password reset workflow: status and manual reconciliation

Status: **NOT READY as a secured path.** Keep it disabled for real accounts. This page states what the template guarantees, what is proven, and what an operator does after an interruption. It is not a promise of end-to-end safety.

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
| Run failed or waiting, approval consumed, no applied revision | Claim done, effect not recorded. Another node or run is refused. | Only the same node can resume. Otherwise create a new approval and a new run. |
| Credential on the run branch, nothing published | Versioned, not live. | Discard the branch, or publish it through the normal review. |
| Data merged on main, activation not recorded | The new credential may already be live while the account is still blocked. | Re-run publication of the same head (it only completes the activation), then lift the block with the account blocks page. |
| Run restarted after a crash | The generated password lived in memory and is gone. No mail can be sent. | New approval and new run. Do not reuse the old credential. |
| Account stays blocked | Unblock only runs at the end of the path. | An administrator lifts the block that this run set, after checking the credential state. |

No step above needs a secret in a ticket, a log or this page.
