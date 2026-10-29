# Profile fields (plugin-declared) - first slice

Status: API slice only. Fictional data only (Dolt history keeps every value).

## Done and tested (147 API tests, incl. a real Dolt server test)
- A plugin manifest may declare `profileFields` (key, label, type, authority flag). Keys are namespaced by plugin id.
- Core base fields: display_name, email, department (authority), manager_id (authority). Base fields are not yet editable through the value store.
- Admin settings per field: hidden, enabled at sign-up, read-only after sign-up, editable by the user, editable by an admin. Stored as core settings, staged on the working branch, live after Apply.
- Authority fields (department, manager, grade...) are refused for self-edit and sign-up by the config validator and again at write time. The subject always comes from the token, never from the body.
- Values: table `profile_field_values(tenant, subject, field_key, value)`. User edits commit on main; admin edits stay on the working branch until Apply. Merge spike: a main edit made after the branch was cut merges without conflict.
- Example plugin `hr-attributes` (job_title, phone, language, employee_grade).

Endpoints: GET/PUT `/tenants/:t/profile-fields`, GET `/tenants/:t/profile-schema?context=signup|self|admin`, GET/PATCH `me/profile`, GET/PATCH `users/:id/profile` (admin).

## Not done
- Web UI (admin page, profile page, dynamic Users columns).
- Public sign-up (stays absent; must be off by default, e-mail confirmation, rate limit, no roles granted).
- Organizations and roles sections/CRUD.
- Hooks `profile.validate` / `signup.check`; `profile.enrich` is declared but never called.
- Deviation from the plan: one core values table, not one table per plugin.

## Update: sign-up, organizations, roles (second commit)
- Sign-up (`/signup` page, `POST /tenants/:t/signup`): closed unless an admin enabled it AND applied it. A request lives outside Dolt (in memory, max 50, 24 h, 5 per IP per hour), needs a confirmation code (simulated outbox, no real mail), then an admin approval; approval creates an account on the working branch with NO role, department or manager. Answers are neutral (taken id/e-mail look like success). Password is hashed at once and never stored in clear.
- Organizations plugin: CRUD + memberships by an admin, tables `organizations` and `org_memberships` on Dolt (branch, live after Apply). Memberships are not a profile field and not editable by the person; shown read only on the profile.
- Roles: role definitions (id, label, sensitive flag) and SoD rules are managed by an admin on the working branch (Roles page, `/tenants/:t/roles`). Grounding: what a role may do lives in `policies/*.cedar` (e.g. `context.roles.contains("payment-approver")`), so a new role grants nothing; ids are immutable; a role that is assigned or in a rule cannot be deleted; removing a rule needs `confirm: true`; Apply still runs the SoD violation check. Role assignment stays in Assignments; the profile only shows roles read only. Writing policies is out of scope.
- Concurrency: same field/person edited by an admin on a branch and by the person on main = explicit Dolt conflict at Apply ("data conflict(s)"), neither value lost (tested).
- Claims: a user self-edit changes only `profile_field_values` (tested byte-identical identities/roles/assignments).
- Enforced in the API: public sign-up cannot be opened, and the form/endpoint stay 404, outside the hosted workspace mode (tested). Mutating routes that took any valid token (changes, CSV/SCIM connectors, merge, activations, activation workflows) now need the admin capability (tested for two tenants). The tenant-bound reads (assignments, decision audit, activation journal) still answer to any valid token of that tenant: restrict them before real people can sign up (out of scope here). `POST access/check`, agent delegations and tool calls stay open to a valid token: they act only as the token subject.
- Still out of scope: real e-mail (confirmation uses the simulated outbox; SMTP not wired to sign-up, no real address ever mailed), persistent pending requests (in memory), e-mail change with re-authentication, per-plugin value tables, `profile.validate`/`signup.check` hooks, policy editing, IdP-side enforcement that a new account cannot sign in before Apply (login works only after Apply because credentials are checked against main).
