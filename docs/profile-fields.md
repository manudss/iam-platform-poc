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
