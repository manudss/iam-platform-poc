# Testing the sign-in on a data branch (before merge)

An administrator can try the **full login experience as a visitor would see it on a data branch** — the sign-in page, the configured chains and methods, and the signed-in app — before that branch is merged into `main`. The data (configuration, forms, profiles) comes from the chosen branch; nothing about the live sign-in on `main` changes.

## Flow

1. In the console's data-branch bar, select a branch and press **Test sign-in on this branch**.
2. The server issues a **short-lived test ticket** (10 minutes, in memory, single use per branch) and a test link `/login?branch=<name>&ticket=<ticket>` opens in a new tab.
3. The login page loads the branch's sign-in configuration (`GET /api/tenants/:tenant/signin/options?branch=&ticket=`): the chains, methods and branding of that branch, not `main`. The sign-up link is hidden in test mode.
4. Signing in runs the core IdP through the API gate with the branch parameters. The core sets a `branch` claim in the issued token (the claim is core-set only; the gate can never plant it, because `safe_auth_claims` does not whitelist it).
5. After the callback, the app enters test mode: a banner shows the tested branch, navigation is reduced to the overview and the personal profile, and every business request carries `x-iam-branch: <name>`. **Exit test** or closing the tab ends it.

## Authorization: tickets, not name knowledge

Knowing a branch name is never enough to test it. A branch test requires a ticket issued by `POST /api/tenants/:tenant/workspace/branch-test` (admin capability required) for an existing, non-`main` branch. The gate checks the ticket on the first page of a test sign-in; an invalid or expired ticket gets a generic refusal. Tickets are bound to one branch: a ticket for `feature-x` never authorizes another branch. Tokens carry the branch in a signed claim, and the API refuses a token presented with a different `x-iam-branch` header.

The public sign-in options endpoint answers for `main` without a ticket; for any other branch it requires the valid ticket, so branch configurations are not exposed by name guessing.

## Write guards: what a test session can never touch

Credentials, enrollments and the rest of the shared, unversioned state stay on the live deployment. A branch-test token is refused on:

- enrollment writes and deletes (`POST/DELETE /tenants/:tenant/authn/enrollments/...`) — no test session ever creates or removes real credentials or secrets;
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
- Tickets live in memory for 10 minutes; a restart invalidates them. On the free hosted demo they vanish with the data on restart, like everything else.
- Ticket creation needs the admin capability, so test links are not shareable with non-admins yet — relaxing this is a product decision, the plumbing would not change.
- Enrollments, secrets, the outbox and sign-up stay live and shared: a test session can read what any sign-in reads but cannot write them, and sign-up keeps enrolling real accounts on the live deployment.
- The test is about **data** (configuration and profiles) on a branch. Method behaviour that depends on shared state (a real e-mail code, a TOTP secret) uses the live enrollments.

## Routes

| Route | Role |
|---|---|
| `POST /api/tenants/:tenant/workspace/branch-test` `{branch}` | Admin: create a 10-minute test ticket. Returns `{branch, ticket, url}`. |
| `GET /api/tenants/:tenant/signin/options?branch=&ticket=` | Branch sign-in configuration for the test login page (ticket required). |
| `POST /internal/auth/entry` and `authenticate` (gate) | Accept `branch` + `ticket`; the ticket is checked on the first page, the running session is bound to its branch. |
