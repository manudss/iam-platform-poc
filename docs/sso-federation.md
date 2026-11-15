# SSO federation: sign in through an external provider (social sign-in)

Status: design + implementation in progress (feature/auth-social-login). Complements `docs/sso-decision.md`
("inbound federation will use openid-client") and the catalogue entry "External identity provider".

## What it is

Each external provider is **its own plugin**, one authentication method type each:

| Plugin | Slot | Protocol (verified) |
| --- | --- | --- |
| `auth-sso-google` | `auth.sso-google` | OIDC (authorization code + PKCE S256) |
| `auth-sso-microsoft` | `auth.sso-microsoft` | OIDC (Entra, common/organizations/consumers tenant setting) |
| `auth-sso-facebook` | `auth.sso-facebook` | **OAuth 2.0 only - Facebook Login is NOT OIDC.** User access token checked server-side against Graph `/me` (+ `appsecret_proof`); optional `debug_token` when an app token is configured |
| `auth-sso-github` | `auth.sso-github` | **OAuth 2.0 only - GitHub is NOT OIDC.** User token checked against `GET /user` (PKCE supported since 2025-07) |
| `auth-sso-oidc` | `auth.sso-oidc` | Generic OIDC (discovery document), several instances = "and other providers" |

Each plugin has two modes, always explicit: **real** (client id + secret configured, real provider calls) and
**simulated** (no credentials: a clearly marked DEMO screen asks which fictional identity to return; a simulated
step proves nothing and is reported as such by `auth.verification`, like the demo outbox). A real mode is never
silently downgraded.

## Security contract (fixed before writing code)

1. **No blind e-mail linking.** A provider identity maps to a directory account only through an explicit link
   recorded while the account holder was signed in (self-service profile component). Matching on a verified
   e-mail claim alone never signs anyone in.
2. **Linking needs authentication.** The link is created from the member's own session (profile page), through a
   provider round-trip with its own state/nonce/PKCE.
3. **Federation is not an MFA factor.** The method declares factor `other`; a federated step never makes a chain
   `auth_mfa` by itself (it can be the single step of a chain, or combined with a real second factor).
4. **Protocol checks**: PKCE S256 always; `state` one-use and bound to the sign-in session; OIDC `nonce` checked
   against the ID token; issuer, audience (exact client id), expiry and JWKS signature checked on every ID token;
   `redirect_uri` exact match, https outside localhost; codes exchanged server-side only.
5. **Secrets**: client secrets are `secret` settings or env refs, never in Dolt/exports/logs; the bus maskers
   cover the callback payload (`code`, tokens) by the existing DENY rules.
6. **No exploitable demo in real mode**: the simulated screen only exists when no client id is configured, and
   every page and claim says SIMULATED.
7. The sign-in session rules stay: 5 minutes, throttling, generic refusals, fail closed on plugin fault.

## Flow (subject first, then provider)

The person enters their account name as today (the subject rules of the existing flow do not change). A social
step renders a **link field** (new core field type `link`: an anchor button, no input). The link points at the
plugin's start route, carrying the flow session id:

1. `auth.prepare` (pure handler) returns the link prompt; the flow session id travels in the payload.
2. `GET /tenants/:t/plugins/<id>/start` (public route): mints `state` + `nonce` + PKCE verifier, stores them in
   the session's pending-external slot via AuthnService, 302 to the provider authorize URL.
3. Provider redirects to `GET /tenants/:t/plugins/<id>/callback`: state check, code exchange, token/userinfo
   validation, then `AuthnService.completeExternal(session, instance, { sub, email? })`.
4. The API resolves the linked directory account from the enrollment store, calls `auth.verify` over the bus
   (audit/fault path preserved), advances the session and 302s the browser to the core sign-in page with
   `session=<id>`.
5. The core resumes the session (new GET support): next step's challenge, or the normal allow+claims.

A social-ONLY chain (no username) comes after this base works: the provider's `sub` resolves the subject through
the link table. Never through e-mail matching (rule 1).

## Pieces

- core (Rust): `link` field type in `input_html`; GET resume with a session id; tests in authz.rs.
- flow.service: session id in the method payload; pending-external state; `completeExternal` + resume; the
  finish path extracted from `check`.
- enroll-store: external links per tenant/subject/instance (sub, email, linkedAt), same storage class as the
  other enrollment records (never Dolt).
- plugins: the five above, pure handlers + httpRoutes (start/callback/link management), shared protocol helpers
  copied per plugin (plugins own their dependencies).
- console/profile: a "linked sign-in providers" component per plugin (link while signed in, unlink).

## Tests (each commit with its tests)

- authz.rs: link field rendering (escaping, https-only, length caps), resume GET.
- flow: external completion advances, wrong/expired state refused, session expiry, subject binding.
- plugin per provider: prepare renders the link; verify checks sub/claims; simulated mode honest.
- bus-routing-coverage and SENSITIVE/grants updated for new hooks if any.
