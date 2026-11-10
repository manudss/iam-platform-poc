# Protected branches and the merge policy

Protection is a visible per-branch setting (Explorer > Branches). `main` is protected by default (`IAM_PROTECTED_BRANCHES` names the built-in ones).

## Rules of a protected branch
- **No direct writes.** Changes arrive only through a pull request (or the global Apply in workspace mode).
- **Checks.** Conflicts, constraint violations and Separation of Duties are re-checked at merge time.
- **Reviews.** `minReviews` (default 0, or `IAM_PR_APPROVALS`): that many approvals from someone other than the author are needed.
- **Who can merge.** Not a list of people. `mergeRule: "policy"` (default) asks the policy engine for the Cedar action `branch:merge` as the caller; `"anyone"` skips that check.

## The merge policy
The demo rule `merge-into-protected-needs-branch-merger` (set `default`, pillar `versioning`) permits `branch:merge` for a person holding the `iam-admin` or `branch-merger` role. Roles come from the ACTIVE version (main), so a role granted on a working branch changes nothing until a human merges and activates it. Demo seed: `demo-alice` holds `branch-merger`, `demo-bob` does not. The rule is business data: edit it in the Policies screen to use other roles or policies.

### Demo cases (seeded)
| Case | Rule | Who (demo) |
| --- | --- | --- |
| Merge into any protected branch needs a role | `merge-into-protected-needs-branch-merger` | `iam-admin`, `branch-merger` (demo-alice) |
| Merge into `main` only | `merge-into-main-needs-main-merger` (`resource == Branch::"main"`) | role `main-merger` (not assigned by default) |
| Merge `profile/` branches into a protected branch, nothing else | `merge-profile-branches-into-protected` (`source_kind == "profile"`) | role `manager`, user `demo-lucie` (demo data seed) |

Protect an existing branch with the Protect button on its card (Branches tab); remove it with Remove protection in its panel (not offered on the default branch, whose protection is built in). Lowering protection needs the same merge policy.

Refusal: HTTP 403, code `merge-not-permitted`, with a message naming the branch. The pull request page shows it before the click (Merge disabled, reason shown).

## Safety notes
- Fails closed: engine unreachable or `IAM_CORE_URL` unset means refused.
- Bootstrap: before the very first activation there is no policy anywhere, so the first Apply is allowed.
- **Existing instances**: an active version without a rule for `branch:merge` denies every merge. Add the rule (and a role assignment) through Policies/Roles first, or set `IAM_MERGE_POLICY=off` as a temporary escape hatch.
- Lowering protection (unprotect, `anyone`, fewer reviews, checks off) needs the same `branch:merge` permission. Raising it does not.

## API (administrator capability)
- `GET /tenants/:t/versioning/protection`
- `PUT /tenants/:t/versioning/branches/:name/protection` with any of `protected`, `minReviews`, `mergeRule`, `requireChecks`, `requirePullRequest`.
- `GET .../pulls/:id` adds `protection` and `mayMerge` (`allowed`, `message`) for the signed-in person.

Settings live in the unversioned `<db>_meta` database next to pull requests (never merged). Not built yet: per-role merge matrix, per-table ownership, protection by branch pattern (`release/*`), a required-checks list.

## Branch folders

Auto-created branches use one folder so merge policies can target a kind of branch:

| Folder | Created by |
| --- | --- |
| `personal/` | the personal admin branch of each user |
| `profile/` | profile edits that wait for review |
| `ai/` | AI / MCP sessions (the session id itself stays `mcp-...`) |
| `workflow/` | workflow runs that change data |
| `feature/` | branches created by hand |

Branches created before this convention (`demo-alice`, `profile-...`, `mcp-...`, `wf-...`) keep their name and are classified by `branchKind`. A name has at most one folder level.

## Per-branch rules beyond roles

Each protected branch also has:

- `minReviews`: approvals from someone other than the author (0 by default, configurable).
- `selfMerge`: may the author merge their own pull request (default yes). When off, the merge is refused with `self-merge-not-allowed`.
- `sourceKinds`: the branch folders (`personal`, `profile`, `ai`, `workflow`, `feature`, `other` = no folder, `custom` = every custom folder, or `custom:<folder>` for one, e.g. `custom:team`) that may be merged into it. Empty means every kind. A merge from another kind is refused with `source-kind-not-allowed`.

Loosening any of these on a protected branch needs the same `branch:merge` permission as merging into it.

The policy engine also sees the folder: the `branch:merge` request carries `context.source`, `context.source_kind` (`custom` for a folder of your own) and `context.source_folder` (e.g. `team`). The seed ships the rule `merge-profile-branches-into-protected`: the `manager` role may merge `profile/` branches into a protected branch, and no other kind. Write more rules the same way, for example one that lets a role merge `workflow/` branches only.

## Creating branches by hand

The Explorer form takes a folder (`feature`, `custom`, or none) and a name; the `/` is added for you. `personal/`, `profile/`, `ai/` and `workflow/` are reserved for branches the platform creates: `POST /versioning/branches` refuses them with 400. "Create protected branch" creates the branch and turns protection on; the protection card then sets reviewers, self-merge, merge rule and allowed source folders.
