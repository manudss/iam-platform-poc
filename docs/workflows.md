# Workflows (IGA scenarios)

The workflows feature demonstrates identity-governance scenarios (joiner, leaver, access change, access review) as
**graphs of typed steps** built in a visual editor, executed by the API, and followed step by step.

## Enabling the feature (plugin)

Workflows are a built-in **plugin** (`workflows-iga`, kind `workflow` + `ui`), managed like every other plugin from the
**Plugins** page. It is **disabled by default** for a tenant: an administrator installs it, then enables it (no grant
is required: the plugin declares no hook, no migration, no component screen).

While the plugin is disabled:

- the console hides the **Automation (IGA) / Workflows** menu and the `/workflows*` routes redirect to the Plugins page;
- every workflow API endpoint answers **403** (`the Workflows (IGA) plugin is disabled…`) — the gate is server-side,
  not just hidden navigation;
- **a run already executing when the plugin is disabled is left to finish**: its data stays on its own `wf-<run>`
  Dolt branch and main is untouched. Retry, cancel, review and every other action are refused until the plugin is
  re-enabled. Disabling never deletes definitions, runs or branches.

## Three badge categories, never mixed up

Every step carries a badge on the canvas, in the palette and on the run view:

| Badge | Types | Effect |
|---|---|---|
| **SIMULATED** | `wait`, `notify`, `fail` | Orchestration only. A wait really waits; a `notify` step **only writes a log line — nothing is ever sent** (no e-mail, no message); a `fail` step fails on its first attempt and recovers on retry (`config.mode: "always"` keeps failing, to show a permanently blocked run). |
| **COMPUTED** | `text-transform` | The step **really runs and computes its output** (real string operations, the real Activepieces piece code), and downstream steps consume that output. It only has **no external effect**: nothing is sent, called or written. The badge exists so a real calculation is never read as a fake one. |
| **REAL** (data / external) | `assign-role`, `revoke-role`, `set-department`, `set-profile-field`, `http-request`, Google Sheets and Jira blocks, `lyam-create-user` | Write business data in Dolt, **always on the run's own branch `wf-<run>` created from `main`**, one commit per step, with the SoD check after an assignment — or perform an external call (HTTP, Sheets, Jira; a dry-run says so in the step log). `set-profile-field` records one profile value (`profile_field_values`) for a person. **A run never writes on `main`.** |

A contributed block declares its category (`simulated` | `computed` | `real`); it defaults from the `simulated`
flag (`true` -> SIMULATED, `false` -> REAL), so older blocks keep their badge. The definitions list counts the
three families separately (Simulated / Computed / Real columns).

Publishing stays the existing human path: from a completed run, "Review & open a pull request" opens the Dolt pull
request for the run branch; a person reviews the diff and merges (a SoD conflict is refused with 409, exactly like a
manual change). The workflow itself never merges.

## Editor

The console page **Workflows** (`/workflows`) shows the definitions as **cards**: mini graph thumbnail, step
count, run stats (runs, ok %, last run), a pause switch, search, Active / Paused / Failed-last-run filter chips,
sorting, and Run / Edit / Runs / more (duplicate, export, delete, import JSON) actions, then recent runs.
The **Templates** gallery (`/workflows/templates`) offers the sample workflows by category with the same
thumbnails; **Use template** creates a copy as a new, **paused** workflow and opens it in the editor. The editor (`/workflows/edit/:id`)
uses **ngx-vflow** (MIT, Angular-native node-graph editor — <https://github.com/artem-mangilev/ngx-vflow>).
When the workflow starts on an event, the trigger is drawn as the **first canvas node** (dashed amber look,
TRIGGER badge, no incoming handle), automatically linked to every root step; it is a visual node only — the
trigger itself is edited with the Start trigger field above the canvas and never saved as a graph node.

Editor choice, checked on 2026-10-30: Temporal has **no official visual workflow editor** (the Temporal Web UI is
read-only observability); community Temporal graph editors are experimental. Reusing an existing, maintained,
framework-native graph library (ngx-vflow, peer dependency Angular >= 19.2.17, this repo uses Angular 22) covers the
n8n-style editing experience without rebuilding one.

Eight sample scenarios can be loaded from the editor: three start manually (onboarding, offboarding, an SoD-blocked
grant whose merge is refused at review), three start by themselves on application events (joiner on
`user.created`, mover into finance on `user.department-changed` with a match filter, leaver on `user.disabled`), and
two show the logic blocks (an If/Merge branch on the department, a Loop over the roles of a sheet row).

### Editor workbench (direction C)

The editor is a workbench: a left rail with the searchable block palette (drag & drop onto the canvas, or click),
a light canvas with minimap, zoom controls and auto-layout (topological layers), a right config drawer with
**Settings / Input / Output** tabs, and a bottom status bar. Ergonomics:

- **Workbench tabs**: the workflows and runs you open live in a tab bar on top of the editor and run pages
  (persisted in the browser). Closing the current tab switches to the previous one; `+` goes back to the list.
- **Active toggle**: the header switch maps to the definition's `active` flag. A paused (inactive) workflow never
  starts from an event — its triggers are skipped by the dispatch and the sheets poller — but a manual **Run**
  still works. The flag is kept as-is on a save that does not touch it.
- **Placeholder picker**: typing `{{` in a step field opens an autocomplete of the placeholders valid there
  (event payload keys, outputs of upstream steps); arrows + Enter pick, Escape closes. The placeholder chips of
  the Settings/Input tabs insert into the last edited field (they only copied before).
- **Insert on link**: every link carries a small `+` that inserts a block rewired between its two ends (the branch
  label, if any, stays on the upstream half).
- **Branch links**: logic steps (If / Switch / Loop) label their outgoing links (`true/false`, case keys +
  `default`, `each/done`); any step can have an `on error` link that catches its failure and lets the run complete.
  A label editor sits directly on the link.
- **Undo/redo** (Ctrl+Z / Ctrl+Shift+Z), **copy/paste** of a multi-selection (Ctrl+C/V, selection box, Delete key),
  workflow **duplicate**, definition **export/import** as JSON.
- **Live validation** (status bar + clickable issue list): required fields, placeholder references (event keys and
  upstream step outputs), branch-label rules, cycles, nested loops, disconnected steps. Errors block Save.
- **Test run**: the Test bar executes the current canvas (unsaved changes included) via `POST /workflows/test-run`
  with a JSON event payload. Real steps write on a **disposable** `wf-test-<id>` branch dropped when the run ends;
  test runs are hidden from the default executions list and can never be reviewed. The canvas tints each node with
  its live outcome.

Initial canvas framing: custom component nodes only report their real size after Angular renders them, so the editor
does not fit the view on a fixed timer (which raced the measurement and sometimes framed the graph half-clipped or
tiny). It waits until the canvas is initialized and every node is measured in the DOM, fits the whole graph, verifies
the visible result (every node inside the canvas) and retries a bounded number of times when the fit ran on stale
sizes. When the fit has to shrink the graph below comfortable reading size, the view zooms back toward 1:1 anchored on
the leftmost node and the user pans to the rest.

## Start triggers (application events)

A definition can carry a **start trigger**: an application event it answers to. When the event fires, a run starts
by itself — no click. The catalog (`GET /tenants/:t/workflows-events`) is published by the server and feeds the
editor's trigger select:

| event | fires when | payload keys |
| --- | --- | --- |
| `user.created` | an administrator creates a user | `subject`, `displayName`, `department`, `email` |
| `user.department-changed` | a user's department changes | `subject`, `from`, `to` |
| `user.disabled` | an account is disabled | `subject` |
| `signup.requested` | a sign-up request is submitted on the public page (registration) | `subject`, `email` |
| `signup.approved` | a sign-up request is approved | `subject`, `email` |
| `profile.updated` | profile values change (administrator edit, or a user's own edit under the immediate policy) | `subject`, `keys`, `actor` |
| `profile.review-resolved` | a validator accepts or refuses pending profile edits | `subject`, `decision` (`accepted`/`refused`), `actor` |
| `organization.member-added` | a user joins an organization (one event per newly added organization) | `subject`, `organization`, `actor` |

- **Match filter**: a trigger may restrict the event, e.g. `{event: "user.department-changed", match: {to: "finance"}}`
  starts only on moves INTO finance. Match keys must be payload keys of the event.
- **Placeholders**: step configs may use `{{event.<key>}}` (e.g. `{{event.subject}}` as the identity of a grant).
  The server refuses a definition whose placeholders do not exist in the trigger's payload, and refuses a manual
  start of a definition that still needs placeholders — only a real event supplies the values.
- A triggered run follows the exact same rules as a manual one: same guard (max 3 active runs per definition),
  real steps write only on the run's own branch `wf-<run>`, the human review merges it. It branches from the branch
  the event happened on and is reviewed back into it. The run's "started by" reads `event:<type>`.
- Safety: events are fire-and-forget (a failing workflow never breaks the user write that fired it), trigger
  dispatch cannot loop (the engine writes through SQL, never through the services that emit events), and nothing
  starts while the `workflows-iga` plugin is disabled on that branch.
- Events are emitted from the single write funnels (`UsersService.save`, also used by sign-up approval;
  `SignupService.submit`; `ProfileService` admin/self edits and review resolution; `OrgService.assign`), so both the
  admin console and the API produce them. Live-side events (public sign-up, a user's own profile edit, a review
  decision) happen on `main`; in the hosted workspace demo the demo seed enables `workflows-iga` on `main` so those
  runs are visible too, and their branches are reviewed back into `main` like any other run.

## Demo scenarios (seeded)

`IAM_DEMO_DATA_SEED=1` seeds triggered definitions that exercise the whole catalog (all idempotent: a re-seed only
adds what is missing):

- **Joiner / Mover / Leaver**: `user.created` grants the employee baseline, `user.department-changed` into finance
  grants accountant, `user.disabled` revokes the baseline (real steps on the run branch + a simulated notify each).
- **Registration**: `signup.requested` tells HR a request waits (simulated only).
- **Onboarding**: `signup.approved` records the entry grade (`set-profile-field`, real) and grants the employee
  baseline (real), then informs the manager (simulated). Approving a sign-up also creates the user, so the Joiner
  fires on the same action — two workflows answering one registration; the duplicate grant is a logged no-op.
- **Validation**: `profile.review-resolved` with `decision=accepted` grants the employee baseline (real) — a refused
  review starts nothing.
- **Organizations**: `organization.member-added` into finance grants payment-creator (real); into the security
  office it only logs (simulated) — the sensitive security-analyst role is never granted by a workflow.

## Runs

- Start: **Run** on the definitions page, or automatically via the definition's start trigger. At most 3 active runs per definition (demo guard).
- Follow: the run page shows every step in execution order with its status (`pending/running/done/failed/skipped`),
  attempts, and its log; the page auto-refreshes while the run is active.
- **Retry** (failed or canceled run): re-runs from the failed step; earlier `done` steps are NOT re-executed. A simulated `fail` step recovers on retry, so a retry normally unblocks the run.
- **Re-run from a step**: on a terminal run, any non-skipped step offers "Re-run from here" - that step and
  everything downstream reset to pending and the run restarts from there.
- The **Executions** screen (`/workflows/runs`) lists every run with status quick-filter chips
  (All / Completed / Failed / Running / Canceled), a workflow filter (preselected from a card's **Runs** link),
  a test-run filter, durations, and an optional **auto-refresh every 5 s**; the run page replays the graph
  colored by step status and shows each step's recorded **input**, output and log.
- On a terminal run: **Re-run** starts a fresh run of the same workflow, **Export log** downloads the run view
  as JSON, and **Delete run** removes the run record (with its branch) after a confirmation.
- **Cancel**: stops a running run (a simulated wait ends at the next tick).
- The run's data branch appears on the run; its commits are visible in Database → History, and the review opens the
  pull request. Deleting definitions while a run is active is refused.

## Execution engine (honest scope)

The default engine is a **local runner inside the API process** (not Temporal): the hosted demo on Render has no
Temporal server. Run state is persisted in the unversioned `<db>_meta` database (same place as Dolt pull requests),
so a run interrupted by an API restart **resumes from its pending steps** (a `done` step is never re-done; a data
step that crashed mid-write left no partial write, the branch working set is reset by the write guard).

The project already runs **activation** through real Temporal when `IAM_TEMPORAL_ADDR` is set
(`src/temporal/`, tested against a real `temporal server start-dev`). Executing these workflow graphs through
Temporal as well is a documented next step; the local runner is what the demo shows today, and it is never presented
as Temporal.

## API (all routes behind AuthGuard + AdminGuard, tenant-scoped)

```
GET    /tenants/:t/workflows-events               start-trigger catalog (events + payload keys)
GET    /tenants/:t/workflows                      list definitions (+ trigger, graph summary, run stats, active flag)
POST   /tenants/:t/workflows                      create {name, description, graph, trigger?}
GET    /tenants/:t/workflows/:id                  one definition (+ execution order)
PUT    /tenants/:t/workflows/:id                  replace
DELETE /tenants/:t/workflows/:id                  delete (refused while a run is active)
POST   /tenants/:t/workflows/:id/runs             start a run
POST   /tenants/:t/workflows/:id/duplicate        copy the definition as "<name> (copy)"
POST   /tenants/:t/workflows/:id/active           pause/unpause {active: bool} (start triggers only fire when active)
POST   /tenants/:t/workflows/test-run             run an ad-hoc graph + test payload on a disposable branch
GET    /tenants/:t/workflow-runs[?definition=&status=&tests=1]  list runs (test runs hidden by default)
GET    /tenants/:t/workflow-runs/:runId           run + steps (input/output/log) + graph edges
POST   /tenants/:t/workflow-runs/:runId/retry     retry from the failed step
POST   /tenants/:t/workflow-runs/:runId/rerun-from/:nodeId  re-run a terminal run from any step
POST   /tenants/:t/workflow-runs/:runId/cancel    cancel
POST   /tenants/:t/workflow-runs/:runId/review    open (or reuse) the Dolt pull request for the run branch
DELETE /tenants/:t/workflow-runs/:runId           delete a terminal run and its branch
```

A graph has 1-20 steps, unique ids, typed configs with no unknown keys, and must be acyclic (validated with Kahn's
algorithm; `apps/api/src/workflows/model.ts`). Logic steps (`if`, `switch`, `loop`, `merge` - COMPUTED family) add
branch-label rules: every outgoing link of an if/switch/loop is labeled, an `if` needs a `true` and a `false` link, a
`switch` a `default` link, a `loop` an `each` link (its body), loops cannot nest, and the `error` label is the only
label a plain step may use.

## Tests

- `src/workflows/model.spec.ts`: graph validation, trigger validation, placeholder extraction and substitution
  (10 unit tests, no server needed).
- `src/workflows/engine-branching.spec.ts`: 10 unit tests of the branching engine with an in-memory store: If/Switch
  branch selection, loops (per-iteration body, maxItems cap), merge semantics, error links, step input capture.
- `src/workflows/workflows.e2e.spec.ts`: 15 end-to-end tests against a **real Dolt server** (set `DOLT_BIN`; the fake
  auth mirrors the real guard's contract, the real AdminGuard is used): simulated run (nothing sent, no branch),
  editor test-run on a disposable branch (hidden from the default list, never reviewable), error-link routing,
  duplicate + re-run-from,
  data run on `wf-<run>` with main untouched until the human merge, SoD conflict logged then refused (409), failure
  + skip + retry with simulated recovery, fail mode "always", failed data step leaves earlier commits only, cancel, definition CRUD.
- `src/workflows/triggers.e2e.spec.ts`: 6 end-to-end tests of the start triggers against a real Dolt server: the
  event catalog, trigger/placeholder validation (400s), `user.created` starts the joiner (placeholders resolved,
  grant on the run branch only, main untouched), the match filter (a move to sales ignored, finance starts the
  mover), `user.disabled` starts the leaver which revokes for real on its branch while main keeps the grant until
  review, and a disabled plugin stops every trigger.

## Limits (POC)

- Sequential execution in topological order (parallel branches of a diamond run one after another, each once).
- Step types are the six above; there is no expression language, no looping, no compensation.
- The local runner has exactly-once *effects* per run attempt but a retry re-runs the failed step: data steps are
  idempotent by construction (INSERT IGNORE / checked DELETE / no-change detection).
- Definitions and runs live in `_meta`: durable while the Dolt data dir lives, wiped with it on the free hosted demo.
