# Dolt database explorer

A "Database explorer (Dolt)" panel in the web app, backed by `apps/api/src/versioning/` (routes `tenants/:tenant/versioning/*`, 22 routes, all behind `AuthGuard` + `AdminGuard`).

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

## Tests
```
cd apps/api && DOLT_BIN=/path/to/dolt npm test     # guards.spec + versioning.e2e.spec (real Dolt 2.6.1)
cd apps/web && npx ng test                          # includes dolt-explorer.spec
NODE_PATH=... DOLT_BIN=... CHROME_BIN=... node scripts/explorer-ui-e2e.mjs /tmp/shots   # browser E2E
```
The browser E2E mounts only the explorer module with a fake sign-in guard (the real AdminGuard is used) and a stand-in identity provider. The older screens (assignments, activations, plugins) need the Rust core, so the harness answers their read calls with fixed demo data; they are covered by the other e2e suites.

GitHub Actions budget is blocked at 0, so tests run locally only.
