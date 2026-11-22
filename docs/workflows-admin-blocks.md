# Workflow administration blocks, task inbox and recertification support

This note documents the administration blocks added to the workflows feature: the human task
inbox (`/workflows/tasks`), task decision and delegation, publication gates with external-state
declaration, decider pools, and crash/restart recovery of the engine. It records what is proven,
how, and which limits remain **explicitly undemonstrated** — a limit listed here is not an
accepted guarantee.

## What was built

- **Task inbox API and screen** (`GET /workflow-tasks`, `/workflows/tasks`): open tasks by
  default, `status=all` to widen, `scope=all` reserved to administrators. "My tasks" returns the
  caller's own tasks plus the tasks of every decider pool the caller belongs to (`admin` pool:
  `IAM_API_ADMIN_SUBJECTS`; `iga` pool: `IAM_API_IGA_SUBJECTS`, falling back to the admins), so a
  non-admin campaign reviewer sees and decides their reviews. The list is capped at 200 rows; the
  API then returns `truncated: true` and the screen shows a banner.
- **Decision** (`POST /workflow-tasks/:id/decision`): server-side authorization (assignee,
  delegate, pool member, admin), justification rules (required to refuse, or when the task asks
  for it), and **anti-self-approval**: the starter chain of the run (including parent runs when a
  sub-workflow started it) and every beneficiary of the request are refused. Deciding resumes the
  run.
- **Delegation** (`POST /workflow-tasks/:id/delegate`): hands a task to another decider.
  **Limit:** the delegation target is a free-form id, not verified by the server; delegating to a
  nonexistent identity strands the task until redelegated.
- **Publication gates**: a publication request parks the run on a human approval, then opens a
  real pull request for the run branch and watches it with a merge-watch task. Deciding that task
  `merged`/`closed` is a **declaration of the externally observed state**: the engine re-reads the
  real pull request state and never merges or closes anything itself on that decision.
- **Engine recovery**: runs interrupted by a crash resume automatically after restart; this is
  proven against the **durable plugin store** (DoltPluginStore). A bounded retry
  (`resumeWithRetry`) tolerates a plugin that is enabled again shortly after boot; if the window
  is exceeded the run carries a visible `RESUME_FAILED:<runId>` error and a restart (or a new
  resume request) picks it up. The marker is only written while the run is still resumable and
  never overwrites a terminal run or a more useful error, and it is cleared when a later retry
  succeeds. Pending retry timers are cancelled on shutdown.
- **Minimized review outputs**: recertification review items expose only what the reviewer needs.
  **Minimized does not mean anonymous**: outputs still carry the identity id, displayName,
  department, manager and roles.

## Test harness vs production

The end-to-end suite boots the API with an **override** of the plugin registry factory: it
registers the same plugin list on the durable Dolt store, but it omits the production guard that
**refuses a Dolt plugin store when a shipped plugin declares secret settings** (the SSO plugin).
No secret value is ever written in the tests, so durability and boot order are exercised
identically; the refusal policy itself is not exercised. Do not read the harness as proving that
a production boot with a secret-bearing plugin set accepts the Dolt store.

With the in-memory store (no `IAM_PG_URL`, no Dolt store), plugin enablement is lost on restart;
that is the documented, expected difference, not a bug.

## Explicitly undemonstrated limits

- **Cross-database isolation** between tenants/branches on a shared server is not demonstrated by
  this work; it remains a limit, not a guarantee.
- A step forced into a failed state by direct SQL simulates a **crash state**, not a real process
  kill; the real-crash proof is the restart test on the durable store.
- The visual proof journey (below) runs against a **local fictional demo instance**; it
  demonstrates the implementation, not any hosted or production deployment.

## Visual proof (local demo)

`scripts/wf-shots.mjs` drives a real local stack (Dolt + NATS + core + API + built console) with
system Chrome: real sign-in of `demo-alice` through the IdP, a publish-approval workflow created
on a fresh working branch and merged to `main` through the pull-request flow, a run started by
its public webhook trigger (so the starter is `webhook` and the administrator may decide),
decision in the inbox, real merge of the run-branch pull request, declaration on the merge-watch
task, and a completed run. Captures live under `docs/images/wf-admin-blocks/`:

1. `01-console-home.png` — console after sign-in.
2. `02-workflows-list.png` — workflows list.
3. `03-templates.png` — templates gallery.
4. `04-run-waiting.png` — run waiting on the publication approval.
5. `05-task-inbox-open.png` — task inbox, approval selected.
6. `06-task-decided.png` — decision `approved` with justification, "the run resumes".
7. `07-run-after-decision.png` — run completed, both steps done.

The script is repeatable: it creates a fresh working branch per run and revokes the previous
proof grant first, so the grant step always has a real change to publish.
