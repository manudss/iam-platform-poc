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
  is exceeded the run carries a visible `RESUME_FAILED: engine unavailable after N attempts: <cause>`
  error; the demonstrated recovery from that state is a restart (a task decision also kicks the run).
  The marker is only written while the run is still resumable and
  never overwrites a terminal run or a more useful error, and it is cleared when a later retry
  succeeds. Pending retry timers are cancelled on shutdown.
- **Run control is race-safe**: every run status change (cancel, retry, rerun-from, completion,
  failure, the crash handler) is an atomic guarded SQL transition (`UPDATE ... WHERE status IN (...)`).
  The first terminal state recorded wins: a cancellation recorded before a late engine write is never
  overwritten by it, and a cancel arriving after a completion or failure is refused (409) instead of
  replacing it. Canceling does not interrupt an effect or step already launched; it is honored at the
  next step boundary.
  Retrying a **canceled** run reopens its parked steps fresh (their durable tasks were canceled with
  the run): a step already done keeps its recorded decision, only the parked step opens a new task.
  The relaunch claims the run through the guarded transition BEFORE resetting any step, so two
  concurrent retries/reruns let exactly one through (the loser gets a 409 without having touched
  anything); a cancel flag left over from the previous cancellation is cleared only if it predates
  the claim, so a fresh concurrent cancel still stops the run. A failure after the claim attempts a
  guarded restore of the pre-claim run state: when the restore succeeds the run is retryable again;
  steps already reset are not rolled back (they are re-derived on the next relaunch).
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
- "Race-safe" covers the **run status transitions and the relaunch claim**. What is proven where:
  the atomic SQL transition primitive and the double concurrent rerun are proven on real Dolt; the
  cancel/pass interleavings are proven on the engine test double. No load testing was done. Known
  residual windows, kept as limits rather than silently closed: a Dolt commit conflict on a
  transition surfaces as a 500 with the state left non-finalized (verified fail-closed: no silent
  wrong state); `cancel` cancels the run's durable tasks just before its own guarded transition, so
  a cancel that loses that race has still canceled the tasks; a kick is fire-and-forget, so an
  engine unavailable right after a won claim leaves the run queued until the next boot resume scan
  (which covers queued, running and waiting runs); and between a relaunch's claim and its step
  resets, a waiting task firing its kick can start a pass on the pre-reset steps. This last window
  is documented, not demonstrated; no guarantee is claimed for it beyond the standing verified rule
  that an interrupted effectful step fails closed (`EXTERNAL_EFFECT_REVIEW_REQUIRED` blocks retry
  and error routes).

## Visual proof (local demo)

`scripts/wf-shots.mjs` drives a real local stack (Dolt + NATS + core + API + built console) with
system Chrome. Two channels are used, and the captures only prove what each channel is:

- **Done in the UI (real browser, real IdP sign-in as `demo-alice`)**: navigation, inbox
  filtering, opening the approval task, typing the justification, clicking `approved`.
- **Done through the API (same identity, admin capability)**: working-branch creation, workflow
  definition save, both pull-request merges, the webhook trigger fire, and the `merged`
  declaration on the merge-watch task.

One test aid, not a standard journey: the console keeps the operator-typed admin capability
token in memory only, so a scripted full-page reload would lose it. The script injects the same
`x-api-admin-token` header at fetch level on every request. The captures therefore prove the UI
journey under a real IdP sign-in, not that an unassisted navigation session preserves admin
rights — the documented operator path remains typing the token in the shell header field.

Captures live under `docs/images/wf-admin-blocks/` (captions limited to what is visible):

1. `01-console-home.png` — console after sign-in.
2. `02-workflows-list.png` — workflows list.
3. `03-templates.png` — templates gallery.
4. `04-run-waiting.png` — run waiting on the publication approval.
5. `05-task-inbox-open.png` — task inbox with the approval selected; the list also shows older
   tasks from earlier capture attempts, some genuinely past their due time.
6. `06-task-decided.png` — the "Task decided: approved. The run resumes." banner (the typed
   justification is below the fold).
7. `07-run-after-decision.png` — run `completed` with both graph nodes checked; only the first
   step row is readable in the steps list without scrolling.

The script is repeatable: it creates a fresh working branch per run and revokes the previous
proof grant first, so the grant step always has a real change to publish.
