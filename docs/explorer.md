# Dolt database explorer

The "Database (Dolt)" section of the administration (seven pages: home, branches, history, compare, data, SQL, pull requests - see [Administration layout](#administration-layout)). The screens follow the validated explorer redesign (PR #69): home dashboard, branch cards, commit-feed history, compare bar with tabs, pull request list/detail with checks, and the data + SQL workbenches (left tree, object tabs, row editor panel with row history)., backed by `apps/api/src/versioning/` (routes `tenants/:tenant/versioning/*`, 22 routes, all behind `AuthGuard` + `AdminGuard`).

## What you can do
- **Home**: database overview (branches, open PRs, tables, recent activity, your workspace).
- **Branches**: cards (ahead/behind vs main), create, delete, tags.
- **History**: commit feed grouped by day, commit detail, restore a branch to an earlier commit (needs confirmation), revert a commit onto a new branch.
- **Compare**: table summary and row-level diff between any two branches/commits/tags, 2-dot or 3-dot (since common ancestor, like a PR), column-level schema diff, open a PR from the bar.
- **Data**: workbench - table tree, object tabs, row filter/sort/columns/CSV; edit rows on a branch (one commit per edit, author = signed-in user); row history from `dolt_history_<table>` with restore-as-new-commit. Commits and tags are read-only.
- **SQL**: workbench - query tabs, read queries (READ ONLY transaction) and write statements (dry-run preview with row samples, then commit; destructive statements need confirmation); saved queries in the tree (localStorage).
- **Pull requests**: list with status pills, search and per-PR check/approval badges; open, comment, approve, close, merge a branch into another. Merge re-checks conflicts, constraint violations and separation of duties. An author cannot approve their own PR.

## Protections and their real scope
- `main` (Dolt) is protected **on the explorer's routes only**: direct writes there are refused, changes go through a PR. Override: `IAM_VERSIONING_ALLOW_PROTECTED_WRITE=1`.
- This is **not Git main**. Git `main` is untouched by this feature.
- The older IAM routes (`/changes` merge, connectors, plugin config proposals, activations) can still write to Dolt `main`. Not changed here.
- Any signed-in demo account has admin rights in the demo. Real role separation is out of scope.
- SQL guard: allowlist (SELECT/DESC/EXPLAIN/WITH, a few SHOW forms, read-only Dolt tables/functions) for reads; DML and table/index/view DDL only for writes; no `dolt_*` procedures, no INTO/SLEEP/@@, no cross-schema access (mysql, `iam_meta`, other DBs). Reads also run in a READ ONLY transaction. Tested against a real Dolt engine, not only a blacklist.
- Write lock is in-process only: one API instance.
- Env: `IAM_PROTECTED_BRANCHES`, `IAM_DEFAULT_BRANCH`, `IAM_PR_APPROVALS`.

## Pull request persistence
PRs live in a separate unversioned database `<db>_meta` (not in branches, so they survive branch deletes). On Render's free tier the disk is ephemeral: PRs and data are lost on restart, spin-down or after the 15-minute sleep.

## Limits
No conflict-resolution UI (conflicting merges are refused), single-instance lock, no real multi-tenant data split.

## Hosted test copy
A second free Render service, `iam-poc-explorer-test` (https://iam-poc-explorer-test.onrender.com), builds branch `feature/dolt-explorer` with `demo/Dockerfile` (env `IAM_PUBLIC_ORIGIN` only, health `/healthz`, auto-deploy OFF: redeploy by hand). It is separate from `iam-poc-demo` (branch `demo`). The edge server adds the admin capability to proxied calls, so nobody types a token there; anonymous calls get 401. Sign in as `demo-alice` / `demo-only-not-a-secret` (fictional). Free-tier facts: Hobby plan, no card, 750 free instance hours per month shared by the whole workspace, 500 pipeline minutes, sleep after 15 minutes, data and PRs reset on restart. `scripts/hosted-explorer-check.mjs <url>` runs the live check (fresh browser, no token typed).

## Tests
Integrated check on the real stack: `scripts/ui-e2e.mjs` (real Rust core + real NestJS API with all IAM/plugin routes + Dolt + the console on `ng serve`) signs in through the core, runs the existing flows (SoD refusal, merge, activation, plugin install/enable/disable) and then drives the explorer (branch, row edit, compare, SQL refusals, pull request, approve disabled for the author, merge, history), checking after each step that no error banner shows and that activation still works after a PR merge. Build the core first: `cd core && cargo build -p iam-core --locked`.
```
cd apps/api && DOLT_BIN=/path/to/dolt npm test     # guards.spec + versioning.e2e.spec (real Dolt 2.6.1)
cd apps/web && npx ng test                          # includes dolt-explorer.spec
NODE_PATH=... DOLT_BIN=... CHROME_BIN=... node scripts/explorer-ui-e2e.mjs /tmp/shots   # browser E2E
```
The browser E2E mounts only the explorer module with a fake sign-in guard (the real AdminGuard is used) and a stand-in identity provider. The older screens (assignments, activations, plugins) need the Rust core, so the harness answers their read calls with fixed demo data; they are covered by the other e2e suites.

GitHub Actions budget is blocked at 0, so tests run locally only.

## Administration layout
The web app is an Angular multi-page administration (router, sidebar, one page per feature) instead of one long page. Nothing was removed: the same components and API calls sit behind the new routes.

| Address | Page |
|---|---|
| `/login`, `/callback` | sign-in (browser code+PKCE flow, legacy JSON login as a diagnostic); `/callback` checks state + verifier, then returns to the page you asked for |
| `/overview` | dashboard: live counts (assignments, activations, plugins, branches, open pull requests) |
| `/assignments` | assignments on Dolt main, simulate a role change on a branch, merge (refused on a Separation-of-Duties conflict) |
| `/activation` | activate the current main, journal |
| `/plugins`, `/plugins/:id` | plugin list; the second form opens the settings/grants of one plugin |
| `/database/home`, `branches`, `history`, `compare`, `data`, `sql`, `pulls` | the Dolt explorer, one section per page (one component instance: branch, comparison and form state survive moving between sections); `/database` redirects to `/database/home` |

- The token is in memory only. A reload or a pasted link therefore goes to `/login` first and comes back to the same page after sign-in (only local app paths are accepted as return target).
- The admin capability token field (local setups only; empty on the hosted demo, where the edge adds it) is in the sidebar and shared by the plugin and database pages.
- Small screens: the sidebar becomes a drawer opened by the menu button; the e2e checks that pages do not scroll sideways at 390 px.
- Tests: `apps/web` unit tests cover the guard, return-URL filter, route matcher and the explorer section/navigation contract; `scripts/ui-e2e.mjs` drives all pages on the real stack (core, API, Dolt), including deep link, refresh and mobile width.


### Session expiry and Organizations regression

The demo user's signed token lasts 300 seconds, unchanged. It remains in memory only.
The console schedules a sign-out at the token's expiry and checks expiry again before an API request
(to cover a suspended/background tab). A 401 from any tenant API request also clears the session,
including the local admin capability, and returns to the sign-in page with an explicit expiry/invalid-session notice.
A 403 remains an authorization error and does not sign the user out. The server still verifies every
signature, issuer, audience, expiry and tenant. Decoding `exp` in the browser is only a UI hint, never authorization.

After a fresh sign-in the console returns to the same local page. No request or mutation is retained or
replayed. Grant checkboxes and unfinished forms are reset. If a request was in flight when the session
ended, check its current state before trying it again: the server may already have completed it.
Requests completing after logout/new login cannot restore their old results into the new session.
There is no silent refresh, token lifetime extension, admin bypass or admin secret in hosted browser storage.
A core restart rotates its signing key, so an old token is rejected and a fresh login is required.

Regression: `scripts/session-expiry-e2e.mjs` starts the real Rust core, Nest API, Dolt and Angular.
It verifies an expired Organizations installation returns 401, reconnects without installing automatically,
then tests a real 12-second idle expiry, a return to `/plugins/org-manager`, explicit installation,
and a core-only restart with old-key rejection/new-key login while the API keeps its JWKS cache.
The suspended-tab case pauses only the client clock; the server clock and rejection are real.
Run with the same DOLT_BIN, CHROME_BIN and NODE_PATH prerequisites as `scripts/ui-e2e.mjs`.

### Author approval

`IAM_PR_PREVENT_SELF_APPROVAL=0` is the default: a human author may approve their
own Dolt PR, useful when an MCP session submits on their behalf. Set it to `1` to
require a different reviewer. `IAM_PR_APPROVALS` independently sets the required
count (default 0). The server enforces the option and tells the UI whether to
disable author approval. Neither setting gives MCP an approve/merge tool.
