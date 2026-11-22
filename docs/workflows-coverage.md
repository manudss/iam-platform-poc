# Workflow admin blocks: coverage and evidence

Status at this commit. Evidence levels: **block** = the block exists in the catalogue; **double** = a test against in-memory doubles; **real piece** = the real Activepieces action against a local fake server; **real Dolt** = a spec on a real Dolt server. A block existing says nothing about its quality.

## Families

| Family | Blocks | Evidence |
|---|---|---|
| Reads (users, roles, assignments, organizations, applications, authn, profile schema, runs) | `lyam-read-*`, `lyam-search-users`, `lyam-list-*` | block, double |
| Users and profiles | `lyam-create-user`, `lyam-update-user`, `lyam-set-login-enabled`, `set-profile-field` | block, double. **Gap**: no block that handles a sign-up request or a self-service profile change review. |
| Roles and assignments | `lyam-create-role`, `lyam-update-role` (new), `lyam-grant-assignment`, `lyam-revoke-assignment`, `lyam-simulate-assignment`, `lyam-propose-role-removal` | block, double. SoD conflicts are read through `lyam-simulate-assignment` only: **gap**, no separate SoD read. |
| Organizations | `lyam-create-organization`, `lyam-assign-organization`, `lyam-org-impact`, `lyam-remove-org-member`, `lyam-propose-org-removal` | block, double |
| Approvals and tasks | `lyam-request-approval`, task inbox, delegation, anti-self-approval | block, double, real Dolt (task consumption) |
| Publication | `lyam-read-diff`, `lyam-request-publish`, `lyam-publish-workspace` | block, double, real Dolt |
| Applications | `lyam-create-application`, `lyam-set-application-enabled`, `lyam-set-application-roles`, `lyam-propose-application-removal` | block, double |
| Authentication | `lyam-read-authn`, `lyam-read-enrollments`, `lyam-propose-authn-policy`, `lyam-request-reenrollment` | block, double. Re-enrollment is immediate and not versioned. |
| Policies | `lyam-validate-policy`, `lyam-propose-policy-change` | block, double |
| Plugins, mail templates, theme | `lyam-read-plugin-states`, `lyam-propose-plugin-change`, mail template and theme read/preview/propose | block, double |
| Imports | `lyam-import-csv`, `lyam-import-scim` | block, double. **Gap**: no bulk connection test. |
| External connectors (Activepieces) | Sheets read/update/add-row; Jira create/search plus **get, comment, transition (new)** | block, double; Jira get/comment/transition: real piece against a local fake Jira server. Not tested against a real Jira site. **Gap**: Sheets find-rows and create-column are not wrapped. |
| Sub-workflows | `lyam-start-workflow`, `lyam-read-run` | block, double. **Gap**: no block that waits for a child run; the child is followed by reading its run. |
| Delegations | `lyam-list-delegations`, `lyam-revoke-delegation-request` | block, double. **Gap**: no block that proposes a bounded access for an agent. |
| IGA recertification | `iga-*` | see below |

## IGA recertification, six steps

| Step | Block / service | Evidence |
|---|---|---|
| 1. Freeze the scope | `iga-create-campaign` (cap 200 items, Lyam roles only) | double |
| 2. List items | `iga-list-items` | double |
| 3. Open review tasks | `iga-open-review-tasks`, now with optional `dueInDays` (1 to 90) and `escalateTo` | double |
| 3b. Late and absent validators (new) | `iga-read-overdue` (read only), `iga-reassign-review`; a manager that is unknown or login-disabled sends the task to the IGA pool and the item says so | double |
| 4. Decisions | `iga-await-decisions`, durable tasks, anti-self-approval | double, real Dolt (tasks) |
| 5. Remediation | `iga-prepare-remediation` (re-reads access, reports a conflict), `iga-mark-remediated` (re-reads the ref) | double |
| 6. Close with evidence | `iga-close-campaign`, `iga-read-campaign` | double |

Decisions fixed by the owner for this increment: a late review stays visible and is escalated once, never revoked or kept automatically; rights are Lyam roles only; no external or multi-level extension.

## Acceptance criteria

| Criterion | Test | Level |
|---|---|---|
| Restart without loss | tasks are durable rows and a re-run of a step reuses its task; `task-consume-dolt.spec.ts` (kill after claim) | real Dolt for tasks; the campaign flow itself is not restarted end to end |
| Validator in scope, no conflict of interest | `tasks-service.spec.ts` (anti-self-approval), `iga-escalation.spec.ts` (replacement refused when it is the person under review) | double |
| Access changed after launch is detected | `iga-escalation.spec.ts` "access changed after the campaign launched" | double |
| Removal refused or unknown stays visible, never closes wrongly | `iga-mark-remediated.spec.ts` | double |
| Test run without real effect | every write block returns early in test and dry-run mode; `admin-blocks.spec.ts` | double |

No criterion is covered by a full end-to-end real-Dolt campaign run.
