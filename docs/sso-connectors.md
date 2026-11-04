# SSO: applications that sign in through the platform (plugin `app-connector`)

Status: step 1 of the SSO plan. **Configuration only**: you can register and configure applications, but no OIDC or SAML endpoint exists yet (next steps). Fictional data. Not production.

## Direction and decisions

- The platform is the **identity provider** (IdP / OpenID Provider). Third-party applications connect to it as service providers (SAML) or relying parties (OIDC).
- Both OIDC and SAML are planned. Each protocol library will live inside its own plugin that can be enabled or disabled. This plugin (`app-connector`) only holds the registry of applications; the protocol plugins read it.
- Federation toward an external IdP (Entra, Google) is a later phase and is not part of this plugin.
- Order of the work: registry (this PR), OIDC provider, SAML IdP, then the rest of the plan.

## What is stored

One row per application in the Dolt table `app_connectors` (per tenant), so a change is made on a working branch, can be reviewed, and goes live with Apply, like organizations or roles.

| Field | Meaning |
| --- | --- |
| `id`, `name`, `description` | identity of the application (`id`: lowercase letters, digits, hyphens, max 32) |
| `protocol` | `oidc` or `saml` |
| `enabled` | a new application starts **disabled**; an enabled one cannot be deleted |
| `redirect_uris` | OIDC only. Exact URIs, `https` (or `http` on localhost), no wildcard, no fragment, no credentials, at most 10 |
| `entity_id`, `acs_url` | SAML only. SP entity id and assertion consumer service URL (`https`) |
| `attribute_mapping` | name sent to the application -> profile key it is read from |
| `allowed_roles` | roles that may open the application. Empty means nobody: closed by default |
| `secret_ref` | **name** of a secret in the secret store (client secret or signing key) |

**Secrets are never stored in Dolt and never accepted by the API.** A body with `secret`, `client_secret`, `private_key`, `password` or `token` is refused (400). Only `secret_ref` is kept.

## Using it

1. Enable the plugin: Plugins > Application connectors (SSO). It is enabled in the seeded demo.
2. Choose a working branch (not main), open **Applications** in the menu, add or edit an application, then Apply the branch.
3. The seeded demo has three fictional applications: `wiki` (OIDC), `payroll` (SAML) and `crm` (OIDC, disabled).

Admin API (needs the sign-in and the administrator capability, 404 while the plugin is off):

```
GET    /tenants/:t/app-connectors
GET    /tenants/:t/app-connectors/:id
POST   /tenants/:t/app-connectors          { id, name, protocol, redirect_uris | entity_id + acs_url, ... }
PATCH  /tenants/:t/app-connectors/:id      any field above
DELETE /tenants/:t/app-connectors/:id      refused while enabled
```

## Events

After a successful write the plugin emits `app.registered`, `app.updated` and `app.removed` (payload `app`, `protocol`, `actor`). They are in the workflow trigger catalogue, so a workflow can start on them. Every change is also a Dolt commit on the working branch (`app-connector: <actor> changed the application registry`).

## Tests

- `apps/api/src/connectors/app-connector.spec.ts`: validation, admin API, plugin on/off, events.
- `apps/api/src/profile/profile-dolt.e2e.spec.ts`: real Dolt (branch, merge, round trip) and the seed.
- `apps/web/src/app/applications.spec.ts`: form helpers.

## Not done yet

OIDC and SAML endpoints, signing keys, the access decision "may this user open this application" in the core, audit of issued tokens, import/export of metadata, and the MCP tools. See the SSO plan.
