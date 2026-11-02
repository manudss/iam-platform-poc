# Testing the sign-in on a data branch (before merge)

An administrator can try the **full login experience as a visitor would see it on a data branch** — the sign-in page, the configured chains and methods, and the signed-in app — before that branch is merged into `main`. The data (configuration, forms, profiles) comes from the chosen branch; nothing about the live sign-in on `main` changes.

## Flow

1. In the console's data-branch bar, select a branch and press **Test sign-in on this branch**.
2. The server issues a **short-lived test ticket** (10 minutes, in memory) and a test link `/login?branch=<name>&ticket=<ticket>` opens in a new tab. For a long-lived pre-production branch the admin can instead create a **stable link** (no expiry, revocable — see below).
3. The login page loads the branch's sign-in configuration (`GET /api/tenants/:tenant/signin/options?branch=&ticket=`): the chains, methods and branding of that branch, not `main`. The sign-up link is hidden in test mode.
4. Signing in runs the core IdP through the API gate with the branch parameters. The core sets a `branch` claim in the issued token (the claim is core-set only; the gate can never plant it, because `safe_auth_claims` does not whitelist it).
5. After the callback, the app enters test mode: a banner shows the tested branch, navigation is reduced to the overview and the personal profile, and every business request carries `x-iam-branch: <name>`. **Exit test** or closing the tab ends it.

## Authorization: tickets, not name knowledge

Knowing a branch name is never enough to test it. A branch test requires a ticket issued by `POST /api/tenants/:tenant/workspace/branch-test` (admin capability required) for an existing, non-`main` branch. The gate checks the ticket on the first page of a test sign-in; an invalid or expired ticket gets a generic refusal that never echoes the branch. Tickets are bound to one branch: a ticket for `feature-x` never authorizes another branch. Tokens carry the branch in a signed claim, and the API refuses a token presented with a different `x-iam-branch` header; a running sign-in session stays bound to the branch it started on.

**Who creates, who consumes.** Only an administrator creates a ticket. The test link itself is a **bearer secret for 10 minutes**: whoever opens it can load that branch's sign-in configuration and attempt a sign-in — completing it still requires real credentials (enrollments stay live and shared), and the issued token then refuses every shared-state route. Treat the link like a password reset link: fine to open in a fresh browser profile for the test, not to post anywhere.

The public sign-in options endpoint answers for `main` without a ticket; for any other branch it requires the valid ticket, so branch configurations are not exposed by name guessing.

**Stable links.** For a branch that must stay testable over days (a `preprod` branch used to prepare configuration before it is merged to `main`), an admin can create a **stable link**: `POST .../workspace/branch-test` with `{branch, stable: true, label?}`. A stable link has no expiry; it persists across restarts in the tenant meta database (`branch_test_links`, only a hash of the secret is stored) until it is explicitly revoked (`DELETE .../workspace/branch-test/:id`). `GET .../workspace/branch-test` lists the links a tenant admin created (id, branch, label, created date, kind — never the secret). A stable link grants exactly what a 10-minute ticket grants — access to that branch's sign-in under normal authentication, with every write guard below still in force. It grants no extra rights and publishes nothing to `main`; it is not an admin API token, and it does not widen who may see branch configurations beyond holders of the link. Treat a stable link like a shared, revocable test bookmark: distribute it consciously, revoke it when the preprod cycle ends.

## Write guards: what a test session can never touch

Credentials, enrollments and the rest of the shared, unversioned state stay on the live deployment. A branch-test token is refused on:

- enrollment writes and deletes (`POST/DELETE /tenants/:tenant/authn/enrollments/...`) — no test session ever creates or removes real credentials or secrets;
- sign-up (`POST /tenants/:tenant/signup`, `confirm`, and the admin approval routes): sign-up stays live and shared for everyone, but a call presenting a branch-test token is refused — a test session never creates a real account, even by a manual API call;
- the admin outbox (`GET/DELETE /tenants/:tenant/authn/outbox`);
- personal working branches (`POST /workspace/personal`, `rename`, `release`) and **Apply** (`POST /workspace/apply`) — a test session can never merge anything into `main`;
- profile reviews (the pending-review queue);
- issuing further test tickets.

In test mode the personal profile writes **directly to the tested branch** (the pending-review step is bypassed and the response says so): that is the point of the test — seeing the branch's own data flow — while the write itself stays on the branch and reaches `main` only through the normal Apply, done from a regular session.

## Configuration and limits

| Setting | Default | Meaning |
|---|---|---|
| `IAM_BRANCH_TEST` | on (workspace mode) | Set to `0` to disable branch testing entirely (ticket creation and checks both refuse). |

Limits, visible by design:

- Only in **workspace mode** (Dolt branches); outside it there is nothing to test.
- Tickets live in memory for 10 minutes; a restart invalidates them. Stable links are the exception: they persist (tenant meta database) until revoked — they survive restarts on a self-hosted deployment; on the free hosted demo they vanish with the data like everything else.
- Only admins create tickets; the link is bearer for 10 minutes (see above), so sharing it deliberately is possible but must stay a conscious choice — granting a non-admin creation right is a product decision, the plumbing would not change.
- Enrollments, secrets, the outbox and sign-up stay live and shared: a test session can read what any sign-in reads but cannot write them, and sign-up keeps enrolling real accounts on the live deployment.
- The test is about **data** (configuration and profiles) on a branch. Method behaviour that depends on shared state (a real e-mail code, a TOTP secret) uses the live enrollments.

## Routes

| Route | Role |
|---|---|
| `POST /api/tenants/:tenant/workspace/branch-test` `{branch}` | Admin: create a 10-minute test ticket. Returns `{branch, ticket, url}`. |
| `POST .../branch-test` `{branch, stable: true, label?}` | Admin: create a stable link for the branch (no expiry, revocable). Returns `{id, branch, ticket, url, stable: true, expires_in: null}`. |
| `GET /api/tenants/:tenant/workspace/branch-test` | Admin: list this tenant's stable links (never the secrets). |
| `DELETE /api/tenants/:tenant/workspace/branch-test/:id` | Admin: revoke a stable link. |
| `GET /api/tenants/:tenant/signin/options?branch=&ticket=` | Branch sign-in configuration for the test login page (ticket required). |
| `POST /internal/auth/entry` and `authenticate` (gate) | Accept `branch` + `ticket`; the ticket is checked on the first page, the running session is bound to its branch. |
