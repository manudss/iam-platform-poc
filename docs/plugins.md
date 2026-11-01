# Plugins (contract v1)

Status: first usable slice in the POC (registry, manifest, install ledger, settings forms, base/replacement with fallback, admin API and a generic admin screen). State is in memory by default and in PostgreSQL when `IAM_PG_URL` is set (settings, grants, enablement, faults, migration ledger, seeds). Fictional data. Not a marketplace, not production.
Code: `apps/api/src/plugins/v1/`, console: `apps/web/src/app/plugins-admin.*`. The v0 contract (`docs/plugin-contract-v0.md`) stays for the WASM blocking hook and the old async host.

See also `docs/auth-methods.md` for authentication methods, chains and levels.

## 1. Ideas in one page

- A plugin is a **manifest** (data) plus **handlers** (code). The manifest says what the plugin is, which hooks it listens to, what it installs, which settings it exposes.
- The admin console is **generic**. It builds its screens and forms from manifests. A new plugin appears in the console with no console change.
- Some plugins are **base plugins**: shipped, mandatory for a **slot** (for example `auth.password`), always on. A **replacement** extends a base plugin and takes over the slot. Disabling the replacement puts the base back, with the base's own configuration.
- A manifest only **requests**. Running SQL, receiving sign-in hooks and running packaged UI code are **grants** made by an admin, one by one.

## 2. Kinds of plugin

A plugin lists one or more `kinds`. Kinds say what it is for; hooks say what it does.

| Kind | Purpose | Typical hooks | Examples |
| --- | --- | --- | --- |
| `auth-method` | prove who the user is | `auth.authenticate`, `auth.challenge` | password (base), password with lockout, TOTP, passkeys/WebAuthn, SMS or mail OTP, federation to an external OIDC/SAML IdP, smart card |
| `profile` | enrich the user profile and claims | `profile.enrich`, `identity.changed` | organizations and hierarchy, manager lookup, cost center, HR attributes, derived claims (is_contractor), photo, locale |
| `notifier` | deliver messages | `notify.send` | log (base), SMTP, Teams/Slack, webhook, SMS, mobile push, digest |
| `workflow` | steps of approval and certification flows | `workflow.step`, `identity.changed` | manager approval, access review campaign, SoD exception with expiry, four-eyes, escalation after N days, ticketing |
| `ui` | extra screens | `ui.screens` (static) | organizations screen, campaign dashboard, sign-in map, self-service access request page | Hooks journal (optional, see [hooks-journal.md](hooks-journal.md)).
| `connector` | read from or write to a target | `connector.import`, `connector.provision` | CSV, SCIM, LDAP/AD, Entra ID, Google Workspace, SAP, a database, a SaaS API |
| `policy` | contribute to access decisions | `access.decide` (runs in the Rust core as WASM) | off-hours deny, geo fence, device posture, time-boxed access, break-glass |
| `audit-sink` | forward audit events | `audit.event` | syslog, SIEM, object storage with retention |
| `risk-signal` | produce a risk score | `risk.score` | impossible travel, new device, leaked credential check, agent-behaviour anomaly |

Further ideas: AI-agent identity plugins (issue and revoke an agent's bounded delegation, record its tool calls), secrets providers, consent and privacy (GDPR export/erase), data quality (duplicate identities), license or cost tracking, delegated administration, tenant branding.

A plugin may **mix kinds**. `org-manager` is `profile` + `workflow` + `ui`: it adds a claim, reacts to movers, and owns two screens. A federation plugin is `auth-method` + `profile` (it maps external claims to profile attributes).

## 3. Hooks

A hook has a fixed name and allowed modes (`apps/api/src/plugins/v1/hooks.ts`).

- `blocking`: on a request path (sign-in, a decision). Has a deadline (2 s by default) and an owner of the failure: see section 6.
- `async`: reacts to an event after the fact. Idempotent per `effectKey`, deduplicated by the host (same rule as v0).

A plugin can only receive hooks it **declared**, and the registry refuses a handler for an undeclared hook or a declared hook with no handler.
Sensitive hooks (`auth.authenticate`, `auth.challenge`, `access.decide`, `risk.score`) additionally need an admin grant (section 7).

## 4. Manifest

```jsonc
{
  "apiVersion": "plugin/v1",
  "id": "auth-password-lockout",            // kebab-case, also the table prefix: plg_auth_password_lockout_
  "version": "1.0.0",
  "name": "Password sign-in with lockout",
  "publisher": "iam-platform",
  "kinds": ["auth-method"],
  "extends": "auth-password",               // replacement of a base plugin
  "provides": ["auth.password"],            // slot(s)
  "requires": [],                           // other plugins that must be enabled
  "hooks": [{ "name": "auth.authenticate", "mode": "blocking" }],
  "install": { "migrations": [{ "id": "001-attempts", "sql": ["create table if not exists plg_auth_password_lockout_attempts (...)"] }], "seed": [] },
  "settings": [ { "key": "maxFailures", "type": "number", "label": "Failures before lockout", "default": 5, "min": 1, "max": 50, "group": "Lockout" } ],
  "screens": [ { "id": "orgs", "title": "Organizations", "area": "admin", "render": "schema", "schemaRef": "plg_org_manager_orgs" } ]
}
```

Validated at registration (`validateManifest`): id, semver, kinds, known hooks and allowed modes, setting keys and types, no default on a secret, regex validity, migration table names, no `drop table`.

## 5. Install file, settings, forms

**Install** (`install.migrations`, `install.seed`): the installer runs each migration once. The ledger stores a checksum; an applied migration that was edited is refused (`migration-changed`): add a new one. Tables must start with `plg_<id>_`. `drop table` is refused: uninstalling or disabling never deletes data. Seeds run only on the first install. Running any of this requires the `install` grant. The ledger sits behind a `MigrationStore` interface with two implementations: in memory, and PostgreSQL (`pg-stores.ts`), which really runs the migration SQL in a transaction and records `plugin_migrations`, `plugin_seeds`, `plugin_settings`, `plugin_state`. Every table a plugin creates must have a `tenant text not null` column, and seed rows are written once per tenant, so tenants never share seeded data. After an API restart the registry reloads settings, grants, enablement and recorded faults (covered by `plugins-pg.e2e.spec.ts`, real PostgreSQL, skipped without `PG_BIN`).

**Settings** (`settings`): each field has `key`, `type` (`string`, `text`, `number`, `boolean`, `select`, `multiselect`, `secret`, `url`, `list`), `label`, `help`, `default`, `required`, `min`/`max`, `pattern`, `options`, `group`, `visibleIf`. The server validates every save against the schema: unknown keys, wrong types and out-of-range values are refused (HTTP 400). `secret` fields have no default, are never returned (the form gets `********`), and keep their stored value when the console does not re-send them.

**Forms**: `GET /tenants/:t/plugins/:id/form` returns the groups, fields and current values. The console renders them with one component (`PluginsAdmin`): list of plugins with their kind, slot and state, then a **Manage** panel with the form, install, enable/disable and the grant prompts. Saving calls `PUT .../settings`.

## 6. Base plugins, replacements, fallback

Rules checked when a replacement is registered (`PluginRegistry.register`):

1. It `extends` a plugin marked `base` and provides every slot of that base.
2. It declares **every base setting, at least as strict as the base**: same type, required stays required, `min` not lower and `max` not higher, same `pattern`, select options a subset, secrets stay secrets, defaults valid for the base. Any value the replacement accepts is then also valid for the base. It may add settings, including required ones (an API key, for instance): enabling is refused until every required setting is configured, so the switch cannot happen half set up.
3. It handles **every base hook** in the same mode and keeps the base kinds. It may add kinds and hooks.
4. A slot has exactly one base plugin.

Behaviour:

- Enabling a replacement makes it serve its slots **for that tenant**. The base plugin's stored settings and data are not modified.
- Disabling it returns the slot to the base, with the base's own configuration. Nothing is dropped. Re-enabling later does not re-run migrations.
- Base plugins cannot be disabled or uninstalled (`base-required`). To change behaviour you enable a replacement.
- **Failure safety, and why it is not "fall back to the base".** The base is often *less* restrictive than a replacement (no lockout, no extra factor). So the registry never asks the base after a replacement refused, errored or timed out for a **sensitive hook** (`auth.*`, `risk.score`, `access.decide`):
  - the call is refused (`plugin-failed`, HTTP 503), callers must treat it as a denial;
  - the replacement is marked **faulted**: every later call is refused too, the base is not asked, the event is audited (`plugin.fault.closed`);
  - the registry never resets or rolls back a replacement's counters (failed attempts, lockouts) and never retries the credential on another plugin;
  - **recovery is an explicit, audited admin action** (admin capability required), not an automatic bypass: `disable` (return to the base) or `enable` again (clears the fault, keeps the counters). `disable` is refused (`base-config-invalid`) if the base has no valid configuration of its own, and its audit entry states that replacement-owned state is kept but no longer enforced. Plan a second admin credential path outside the faulted slot (the admin token here is separate from the sign-in plugin) so a faulted sign-in plugin cannot lock admins out.
  - Non-sensitive hooks (for example `notify.send`) may fall back to the base on failure: a missed message is not an access decision (`plugin.fault.fallback`).
- A plugin cannot be disabled while an enabled plugin lists it in `requires`.

Not covered yet: data migration between a base and a replacement that stores users in its own tables (for example moving password hashes), and a dry run of a replacement before the switch. A replacement that owns credentials must either read the base's tables or ship an explicit migration that copies, never moves, the data, so the fall back still works.

## 7. Authority boundaries

Declared schemas grant nothing.

| A manifest can ask for | What is required |
| --- | --- |
| tables and seed rows | the `install` grant, tables limited to `plg_<id>_`, no drop |
| a sensitive hook | that hook named in `grants.hooks` at enable time |
| a packaged UI component (`render: "component"`) | `uiComponents` grant. Without it the screen is not listed. `render: "schema"` screens are drawn by the console itself and need no grant |
| reading other tenants | never possible: calls carry the tenant, settings and screens are per tenant |

Changing anything (install, settings, enable, disable) needs the sign-in **and** the admin capability (`x-api-admin-token`, same local-demo mechanism as simulation). Reading the list, screens and forms needs only the sign-in. Every change is written to the registry audit callback.
Not covered: signature check of third-party plugin packages for async plugins (WASM packages are already signed), sandboxing of async handlers (they run in the API process: only ship reviewed code), per-plugin network egress rules.

## 8. Interfaces

- **Async/blocking handlers (TypeScript)**: `(payload, ctx) => result`, where `ctx.settings` are the validated settings. Result shapes are in `hooks.ts` (`AuthenticateResult`, ...).
- **Policy (WASM, Rust core)**: unchanged from v0 (`decide-v0`, fuel limit, no imports, fail closed). v1 manifests list `access.decide` and the signed package carries the same fields.
- **Screens**: `schema` (generic list/form over a plugin table, no plugin code in the browser) or `component` (packaged web component, needs the grant). Only `schema` is drawn in this slice; the `component` grant gate is implemented, the loader is not.
- **HTTP** (`PluginsAdminController`): `GET /tenants/:t/plugins`, `GET .../screens`, `GET .../:id/form`, `POST .../:id/install`, `PUT .../:id/settings`, `POST .../:id/enable`, `POST .../:id/disable`.

## 9. Demo versus catalogue

Covered by running code and tests in this POC: `auth-method` (base password + lockout replacement), `notifier` (log base; a replacement is tested with a failing example), `profile` + `workflow` + `ui` (org-manager, mixed kinds, schema screens only), `risk-signal` (risk-geo, used to demonstrate grants only). Everything else in section 2 (connectors, audit sinks, policy plugins beyond the v0 WASM hook, TOTP, passkeys, federation, ...) is a **catalogue of possibilities**, not implemented here.

## 9b. Worked examples (in the code)

- `auth-password` (base, slot `auth.password`) and `notify-log` (base, slot `notify.default`).
- `auth-password-lockout`: replacement. Same settings plus `maxFailures`, one table, locks after N failures. Tests: replace, lock, explicit disable, base answers again, no `drop`, re-install does not rerun the migration; failure of the replacement is refused, never retried on the base.
- `org-manager`: multi-kind (`profile`, `workflow`, `ui`), two tables, seed row, two schema screens, a claim name setting with a regex.
- `risk-geo`: asks for a sensitive hook and a component screen. Test: enabling is refused until both are granted.

## 10. Tests

- `apps/api/src/plugins/v1/plugins-v1.spec.ts`: registry rules, replacement and return to base, fallback on throw and on timeout, grants, migrations, settings and masked secrets, dependencies.
- `apps/api/src/plugins/v1/plugins-admin.spec.ts`: HTTP: admin capability, grant refusal, validation, tenant isolation.
- `apps/web/src/app/plugins-admin.spec.ts`: form helpers, client headers, form rendered from a schema, grant prompts.
- Run: `cd apps/api && npm test` (listed in the script) and `cd apps/web && npx ng test --watch=false`.

## 11a. Wired into the real sign-in and the activation effects

**Sign-in gate (`auth.authenticate`).** The Rust core can ask the control plane before its IdP checks a password. Set `IAM_AUTH_GATE_ADDR` (loopback host:port only) and `IAM_AUTH_GATE_TOKEN` (8 characters or more, same value on the API) and both the JSON `/authorize` and the browser login form (`/authorize/login`) call `POST /internal/auth/authenticate` on the API. The API answers through `callSlot('auth.password', 'auth.authenticate')`, so the active base or replacement plugin decides.

| Situation | Gate answer | Sign-in result | Plugin state |
|---|---|---|---|
| right password | 200 `allow` | the IdP continues (its own check still applies) | healthy |
| wrong password, lockout | 200 `deny` | refused, `invalid_credentials` (401) | healthy, counters kept |
| plugin threw, timed out, is faulted | 503 | refused, `temporarily_unavailable` (503) | faulted until an admin disables or re-enables |
| gate unreachable or slow (3 s) | none | refused (503), never served by the plain IdP check | not touched |

A wrong password is a business denial: it never faults the plugin for everyone. A technical failure is fail-closed and the base plugin is not asked after a replacement failed. The endpoint answers 404 unless the token is set and 401 on a wrong token. A `challenge` outcome is treated as a denial, because the demo form has no second step. Covered by `signin-gate.e2e.spec.ts` (real core binary, real API, registry) and unit tests in `core/crates/iam-core/src/gate.rs`.

**Notifications (`notify.send`).** With `IAM_EFFECTS=1`, the activation effects also fan out `notify.send` to the active notifier plugins (`role.changed`, one call per effect key, idempotent). It is best effort: a notifier problem is logged and never fails the role effects or becomes an access decision.

## 11b. Plugin configuration versioned in Dolt

Enablement and the non-secret settings of a plugin can be versioned like a role change. Table `plugin_config(tenant, plugin, enabled, settings json)` lives in Dolt (`data/demo/01-schema.sql`).

- `DoltService.proposePluginConfig(tenant, plugin, cfg)` writes the row on a new `change-xxxxxxxx` branch and commits it. Main does not change.
- Review, then the existing `merge(branch)` brings it into main. `pluginConfigAt(tenant, ref)` reads one tenant at a commit, branch or main (tenant isolation).
- `PluginRegistry.exportConfig` produces the versioned form. Secret-typed settings are never exported, so no secret reaches Dolt.
- `PluginRegistry.applyVersionedConfig` applies a merged version through the same checks as the admin screen (settings schema, dependencies, valid base config on disable). It never widens grants: enabling reuses the grants an admin already gave, so a data merge cannot grant a sensitive hook, SQL install or component screen. A merged `enabled=false` is the explicit return to base.

Covered by `plugins-dolt.e2e.spec.ts` (real Dolt, skipped without `DOLT_BIN`). Not wired in the console yet: the proposal and apply steps are API/service level.

## 11. Not done

component screen loader; plugin package signing for async plugins; uninstall with data export; versions and upgrade of a plugin; the other plugin kinds beyond the examples above.
