# SSO: decision record and spike (step 0 of the plan)

Date: 5 Nov 2026. Complements `docs/sso-connectors.md` (registry) and `docs/sso-oidc.md` (OIDC provider).

## Decision

The platform is the identity provider. OIDC uses **node-oidc-provider** embedded in a plugin; SAML will use **samlify**; inbound federation (later) will use openid-client and node-saml. No separate identity server (Keycloak, Hydra...). Choices and scoring: the SSO plan of 4 Nov 2026.

## Spike result: node-oidc-provider inside NestJS

Works as an Express sub-application mounted before the Nest routes (`/sso/:tenant/oidc`). Points learned while building step 2:

- It reads the body Nest already parsed: no extra body parser is needed.
- Endpoint URLs are built from the path it is served under. Behind an edge that strips a prefix (the demo strips `/api`), the plugin sets `req.originalUrl` to the public path, otherwise the discovery document advertises URLs without the prefix. A test covers it.
- `offline_access` is honoured only with `prompt=consent` (OIDC rule): clients must send it.
- Clients are read through a custom adapter from the live application registry; everything else (sessions, codes, tokens) uses an in-memory adapter.
- The user sign-in is delegated to the console through an interaction (`/sso-interaction/<uid>`); the API completes it by writing the interaction result (login + consent grant) and sending the browser to the library's resume URL.
- Pinned: `oidc-provider` 9.13.3 (no `^`), dev: `openid-client` 6.8.9.

## Licence checks (npm registry metadata and LICENSE files, 5 Nov 2026)

| Package | Version | Licence | Evidence |
| --- | --- | --- | --- |
| oidc-provider | 9.13.3 | MIT | npm `license` field and LICENSE file (Filip Skokan) |
| openid-client | 6.8.9 | MIT | npm `license` field |
| samlify | 2.15.1 | MIT | npm `license` field and LICENSE file (Tony Ngan) |
| @node-saml/node-saml | 5.2.0 | MIT | npm `license` field |
| scimmy | 1.3.5 | MIT | npm `license` field and `LICENSE.md` in the package. Last publish 5 Mar 2025, small project: audit the code before adoption (SCIM is still postponed) |

Transitive dependencies were not audited licence by licence; `npm audit` reports advisories on the dev toolchain that predate this work and were not changed here.
