# Protected branches and the merge policy

Protection is a visible per-branch setting (Explorer > Branches). `main` is protected by default (`IAM_PROTECTED_BRANCHES` names the built-in ones).

## Rules of a protected branch
- **No direct writes.** Changes arrive only through a pull request (or the global Apply in workspace mode).
- **Checks.** Conflicts, constraint violations and Separation of Duties are re-checked at merge time.
- **Reviews.** `minReviews` (default 0, or `IAM_PR_APPROVALS`): that many approvals from someone other than the author are needed.
- **Who can merge.** Not a list of people. `mergeRule: "policy"` (default) asks the policy engine for the Cedar action `branch:merge` as the caller; `"anyone"` skips that check.

## The merge policy
The demo rule `merge-into-protected-needs-branch-merger` (set `default`, pillar `versioning`) permits `branch:merge` for a person holding the `branch-merger` role. Roles come from the ACTIVE version (main), so a role granted on a working branch changes nothing until a human merges and activates it. Demo seed: `demo-alice` holds `branch-merger`, `demo-bob` does not. The rule is business data: edit it in the Policies screen to use other roles or policies.

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
