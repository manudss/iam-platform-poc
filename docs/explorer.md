# Dolt database explorer

The "Database (Dolt)" section of the administration (six pages, see [Administration layout](#administration-layout)), backed by `apps/api/src/versioning/` (routes `tenants/:tenant/versioning/*`, 22 routes, all behind `AuthGuard` + `AdminGuard`).

## What you can do
- **Branches**: list (ahead/behind vs main), create, delete, tags.
- **History**: commit log with parents and refs, commit detail, restore a branch to an earlier commit (needs confirmation), revert a commit onto a new branch.
- **Compare**: table summary and row-level diff between any two branches/commits/tags, 2-dot or 3-dot (since common ancestor, like a PR).
- **Data**: browse tables and rows at any ref; edit rows on a branch (one commit per edit, author = signed-in user). Commits and tags are read-only.
- **SQL**: read queries (READ ONLY transaction) and write statements (dry-run preview, then commit; destructive statements need confirmation).
- **Pull requests**: open, comment, approve, close, merge a branch into another. Merge re-checks conflicts, constraint violations and separation of duties. An author cannot approve their own PR.

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
| `/database/branches`, `history`, `compare`, `data`, `sql`, `pulls` | the Dolt explorer, one section per page (one component instance: branch, comparison and form state survive moving between sections) |

- The token is in memory only. A reload or a pasted link therefore goes to `/login` first and comes back to the same page after sign-in (only local app paths are accepted as return target).
- The admin capability token field (local setups only; empty on the hosted demo, where the edge adds it) is in the sidebar and shared by the plugin and database pages.
- Small screens: the sidebar becomes a drawer opened by the menu button; the e2e checks that pages do not scroll sideways at 390 px.
- Tests: `apps/web` unit tests cover the guard, return-URL filter, route matcher and the explorer section/navigation contract; `scripts/ui-e2e.mjs` drives all pages on the real stack (core, API, Dolt), including deep link, refresh and mobile width.
