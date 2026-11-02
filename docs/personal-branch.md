# Personal working branch (administration)

When an administrator opens the console, a personal **Dolt data branch** is already open and selected, named after the user (the token subject, for example `demo-alice`). Work starts immediately; nothing reaches `main` until **Review & Apply**. These are Dolt data branches, not Git branches.

## Rules

- **One per user.** Signing in again reuses the same branch, with the work in progress exactly as it was. No branch is created per sign-in.
- **Rename.** The name field in the data-branch bar renames it. The name is remembered for that user. Refused: `main`/protected names, names already used or reserved by another user, invalid names, and any branch used by an open pull request.
- **Cleanup, empty branches only.** "Empty" means no commit beyond `main` (this includes a branch whose work was already applied to `main`). An empty branch is deleted at sign-out and when it has been idle for `IAM_PERSONAL_BRANCH_IDLE_MINUTES` (default 60) while another administrator signs in. A branch with changes, or used by an open pull request, is never deleted, moved or reset by this feature. The remembered name lets the next sign-in recreate it.
- **Fresh start.** An empty branch that is behind `main` is moved to `main`'s head at sign-in so the user starts from current data. A branch with work is not touched.
- **Isolation.** The routes only act on the caller's own subject. Both guards stay: valid sign-in and the admin capability. The registry (`personal_branches`) lives in the unversioned `<db>_meta` database next to pull request records, so it never becomes part of a merge. On the free hosted demo it is wiped with the data on restart, like everything else.

## API (tenant scoped, admin only)

| Route | Purpose |
|---|---|
| `POST /api/tenants/:tenant/workspace/personal` | Open or reuse the caller's branch. Returns `branch`, `status` (`created`, `reused`, `refreshed`, `recreated`), `empty`, `aheadOfMain`, `behindMain`. |
| `POST /api/tenants/:tenant/workspace/personal/rename` | Body `{ "name": "..." }`. |
| `POST /api/tenants/:tenant/workspace/personal/release` | Delete the branch only if empty and unused (called at sign-out). |

Limit: when the admin capability token is typed by hand (local runs without the hosted edge), the branch opens after the token is entered and **Refresh branches** is pressed.

Related: [testing the sign-in on a data branch](branch-test.md) — an administrator can open a branch's login experience in a test session before merging it. Test sessions never touch enrollments, the outbox, personal branches or Apply.
