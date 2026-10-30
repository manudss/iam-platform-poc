# Workflows (IGA scenarios)

The workflows feature demonstrates identity-governance scenarios (joiner, leaver, access change, access review) as
**graphs of typed steps** built in a visual editor, executed by the API, and followed step by step.

## Two kinds of steps, never mixed up

| Family | Types | Effect |
|---|---|---|
| **SIMULATED** | `wait`, `notify`, `fail` | Orchestration only. A wait really waits; a `notify` step **only writes a log line — nothing is ever sent** (no e-mail, no message); a `fail` step fails on its first attempt and recovers on retry (`config.mode: "always"` keeps failing, to show a permanently blocked run). |
| **REAL** (data) | `assign-role`, `revoke-role`, `set-department` | Write business data in Dolt, **always on the run's own branch `wf-<run>` created from `main`**, one commit per step, with the SoD check after an assignment. **A run never writes on `main`.** |

Publishing stays the existing human path: from a completed run, "Review & open a pull request" opens the Dolt pull
request for the run branch; a person reviews the diff and merges (a SoD conflict is refused with 409, exactly like a
manual change). The workflow itself never merges.

## Editor

The console page **Workflows** (`/workflows`) lists definitions and recent runs. The editor (`/workflows/edit/:id`)
uses **ngx-vflow** (MIT, Angular-native node-graph editor — <https://github.com/artem-mangilev/ngx-vflow>).

Editor choice, checked on 2026-10-30: Temporal has **no official visual workflow editor** (the Temporal Web UI is
read-only observability); community Temporal graph editors are experimental. Reusing an existing, maintained,
framework-native graph library (ngx-vflow, peer dependency Angular >= 19.2.17, this repo uses Angular 22) covers the
n8n-style editing experience without rebuilding one.

Three sample scenarios can be loaded from the editor: onboarding (simulated prep + real grant + simulated notice),
offboarding (real revoke + move + simulated confirmation) and an SoD-blocked grant (completes with a logged conflict,
merge refused at review).

## Runs

- Start: **Run** on the definitions page. At most 3 active runs per definition (demo guard).
- Follow: the run page shows every step in execution order with its status (`pending/running/done/failed/skipped`),
  attempts, and its log; the page auto-refreshes while the run is active.
- **Retry** (failed or canceled run): re-runs from the failed step; earlier `done` steps are NOT re-executed. A simulated `fail` step recovers on retry, so a retry normally unblocks the run.
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
GET    /tenants/:t/workflows                      list definitions
POST   /tenants/:t/workflows                      create {name, description, graph}
GET    /tenants/:t/workflows/:id                  one definition (+ execution order)
PUT    /tenants/:t/workflows/:id                  replace
DELETE /tenants/:t/workflows/:id                  delete (refused while a run is active)
POST   /tenants/:t/workflows/:id/runs             start a run
GET    /tenants/:t/workflow-runs[?definition=]    list runs
GET    /tenants/:t/workflow-runs/:runId           run + steps + logs
POST   /tenants/:t/workflow-runs/:runId/retry     retry from the failed step
POST   /tenants/:t/workflow-runs/:runId/cancel    cancel
POST   /tenants/:t/workflow-runs/:runId/review    open (or reuse) the Dolt pull request for the run branch
```

A graph has 1-20 steps, unique ids, typed configs with no unknown keys, and must be acyclic (validated with Kahn's
algorithm; `apps/api/src/workflows/model.ts`).

## Tests

- `src/workflows/model.spec.ts`: graph validation (7 unit tests, no server needed).
- `src/workflows/workflows.e2e.spec.ts`: 9 end-to-end tests against a **real Dolt server** (set `DOLT_BIN`; the fake
  auth mirrors the real guard's contract, the real AdminGuard is used): simulated run (nothing sent, no branch),
  data run on `wf-<run>` with main untouched until the human merge, SoD conflict logged then refused (409), failure
  + skip + retry with simulated recovery, fail mode "always", failed data step leaves earlier commits only, cancel, definition CRUD.

## Limits (POC)

- Sequential execution in topological order (parallel branches of a diamond run one after another, each once).
- Step types are the six above; there is no expression language, no looping, no compensation.
- The local runner has exactly-once *effects* per run attempt but a retry re-runs the failed step: data steps are
  idempotent by construction (INSERT IGNORE / checked DELETE / no-change detection).
- Definitions and runs live in `_meta`: durable while the Dolt data dir lives, wiped with it on the free hosted demo.
