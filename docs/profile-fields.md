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

## Personal space, edit policy and reviews

- Every signed-in account has "My profile" (self-service). It is separate from the admin screens; an ordinary account sees only that entry. `GET /api/tenants/{t}/me/access` tells the console who is admin and which plugins are active.
- `selfEditPolicy` (profile config): `immediate` (default) writes self-edits straight to the active data (Dolt main); `review` writes them to a personal branch `profile-<subject>` that a validator (admin) accepts (merge into main) or refuses (branch deleted) in "Profile reviews" (`GET profile-reviews`, `POST profile-reviews/:id/accept|refuse`). An author cannot accept their own edits. Authority fields are never self-editable. During a [branch test](branch-test.md) the circuit is identical, scoped to the tested branch: the proposal branch is cut from the tested branch, the review appears with a branch chip, and accepting merges it back into the tested branch — `main` is never touched and there is no test-mode bypass of the review circuit.
- Plugins that are not enabled are hidden from the menu and their pages are guarded.
- Sign-up is offered on the sign-in page when sign-up is open. The confirmation e-mail is simulated (admin outbox, no real mail); approval by an admin is still required and grants no role.

## Plugin-owned storage, sections and profile components (profile-plugins slice)

- A field declaration may carry `storage: { table: 'plg_<pluginId>_…', column, sqlType? }`: the values live in a table the plugin OWNS, created by its install migrations (the migration runner rewrites bare `text` to `varchar(255)`; `mediumtext`/`longtext` survive) and dropped by their inverse when the plugin is uninstalled from its last tenant. The table name must start with `plg_<pluginId>_` (dashes become underscores) - this is what lets the migration runner tell plugin tables apart. A declaration without `storage` keeps the generic `profile_field_values` row store and is treated as a declaration to migrate.
- Adoption: values a field already had in the generic store MOVE to the plugin's table when the plugin is installed or enabled (`POST /plugins/:id/install|enable` answer `adoptedValues`). It is an explicit adoption step, not a plugin migration: plugin migrations cannot touch `profile_field_values` (the `plg_` prefix rule), and running it at install/enable keeps it idempotent.
- `type: 'image'`: the value is a data URL (`data:image/png|jpeg|webp;base64,…`), resized client-side, capped at 256 KB decoded. Example: the `profile-picture` plugin (self-manage, admin read-only).
- New admin settings per field: `adminView` (the admin matrix column; the person may have a field the administrator never sees, e.g. an e-mail), `section` (a plugin-declared or admin-chosen group title for the profile screens) and `order`. The directory core fields can be tuned but never disabled, and `base.display_name` always stays visible to an administrator (the validator refuses both).
- `profileComponents` (manifest): a plugin contributes self-contained blocks to the profile screens - `component` (a `.mjs` custom element served from the package), `surfaces: { self, admin }` each `manage` (interactive), `readonly` or `hidden`, and `order`. The admin tunes surfaces per component in the profile-fields page (stored under `components` in the same versioned configuration; the inventory card shows defaults against effective values). Shipped examples: `auth-totp` (self: enroll/revoke; admin: status and revoke, NEVER enroll for someone else), `auth-digit-code` (PIN), `auth-password` (change; hidden by default), `profile-picture`.
- Grant: shipping profile components takes the explicit `uiComponents` grant at enable, same rule as packaged admin screens - plugin-supplied JS runs in the console. The console's grant list shows it.
- Self-service endpoints (the subject is always the token's): `GET /tenants/:t/auth/me/enrollments`, `POST …/me/enrollments/:i/totp` (secret shown exactly once) + `…/totp/confirm`, `PUT …/me/enrollments/:i/pin` (changing needs the current PIN), `DELETE …/me/enrollments/:i`, `POST …/me/password` (current password re-authenticates). Enrollment secrets never touch Dolt. `GET /tenants/:t/auth/enrollment-stats` (admin) feeds the dashboard counts.
- Lifecycle contract (general for every profile plugin): uninstalling a plugin drops its tables (down migrations), purges its slice of the profile configuration (field settings and component overrides, answered in the uninstall response as `profileConfig`) and `GET /tenants/:t/plugins/:id/profile-values` tells the admin how much profile data the plugin holds BEFORE they confirm.
- Endpoints added: `GET /tenants/:t/profile-components?surface=self|admin` (admin surface needs the capability), `GET …/profile-components-inventory` (admin), `GET …/plugins/:id/profile-values` (admin).
- Deliberately out of scope (noted in the PR): the org-manager `profile.enrich` hook, a list-typed demo plugin, avatars in the users list and toolbar, image truncation in the Dolt explorer, session revocation on password change.

## Demo data seed

`IAM_DEMO_DATA_SEED=1` (set in demo/start.sh, workspace mode, only when main has no organizations): fictional accounts (password `demo-only-not-a-secret`, `example.invalid` addresses), 6 organizations with members, extra roles, the `organizations` and `hr-attributes` plugins enabled, profile values, sign-up open. The seed also installs and enables the shipped `notify-resend` notifier, so a hosted demo with `RESEND_API_KEY` set delivers real sign-in codes from the first boot. `IAM_DEMO_PROFILE_EMAIL` (optional, server environment only): a real mailbox address for the demo sign-in account, used instead of the fictional `example.invalid` one, for hosted demos that exercise real e-mail delivery; unset or malformed keeps the fictional address. Permission-engine effects of the seeded roles appear at the next Apply.
