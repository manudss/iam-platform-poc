# Screen access and people scopes

Who opens which admin screen, and which people a manager or an organisation admin may act on, is decided by Cedar rules (Dolt data `policy_rules`, activated like any other policy). No rule names a person: rules name roles.

## Switch
`IAM_SCREEN_ACCESS=1` (set by `demo/start.sh`) together with `IAM_CORE_URL`: the API asks the core `screen:open` for each admin route (map in `apps/api/src/auth/screens.ts`). Off: the legacy `IAM_API_ADMIN_SUBJECTS` list applies. Before the first activation (no active version) the legacy list also applies; if the core is unreachable the call is refused.

## Screens by role
| Role | Screens |
| --- | --- |
| iam-admin | all |
| manager, org-admin | users, profile-reviews, assignments, my-profile (scoped to their people) |
| main-merger, branch-merger | dolt-pulls, dolt-compare, dolt-history, dolt-branches (write), my-profile |
| everyone | my-profile |

`GET /tenants/:t/me/access` returns the screens the caller opens; the menu and route guards of the web app follow it.

## People scopes
Actions `user:read`, `user:manage`, `assignment:change` (resource `User::"<target>"`, context `role`, `admin_orgs`). The API sends the target as a Cedar entity whose parents are its manager chain (`identities.manager_id`, recursive) and its organisations (`org_memberships` plus `organizations.parent_id`). The caller's own organisations are `context.admin_orgs`. Never herself. Lists are filtered with one decision per row; out-of-scope writes are refused with 403 `person-out-of-scope`. Authority fields (manager, department, login) are written by iam-admin only, and writing `manager_id` is refused if it would create a loop.

Roles a non-admin may assign: accountant, payment-creator, employee, hr-partner, sales-rep. Refused: iam-admin, main-merger, branch-merger, manager, org-admin, payment-approver (and mcp-operator).

## Scoped assignments merge
A manager or org-admin may merge into `main` a branch only if the real diff `main...source` touches only `assignments` and every added or removed row passes `assignment:change`. The gate sets `change_scope = "assignments-in-scope"`, the rule `main-scoped-assignments-merger` allows it. One foreign row refuses the whole merge and the message lists the rows. Merge and activation stay linked.

## Seed users
demo-alice = iam-admin only; demo-lucie = manager only; demo-noemie = main-merger only; noah-petit = org-admin only. Tests prove the others are not super admins (`access/scoped-merge.e2e.spec.ts`, `activation.e2e.spec.ts`, `auth/screen-guard.spec.ts`). The demo seed runs on an empty database only: reset the database (or redeploy a preview) to get new seed users.

## Own branch only, and the branch selector

- A manager (or organisation admin) merges into main only HER OWN personal branch (`own_branch`, read server side from the personal branch registry, never from the caller) and only when the real diff touches assignments of her scope. Another branch, even with in-scope rows, is refused ("you may only merge your own personal branch"). Merge my changes, Review & Apply and Pull requests all go through the same gate.
- The branch selector, Manage branches, rename/release of the personal branch and branch test links need the screen `branch-manage`, opened by the super admin rule only. Everyone else works on their own personal branch, opened for them at sign-in.
