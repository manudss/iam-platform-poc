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
   cover the callback payload (`code`, tokens) by the existing DENY rules. At rest a `secret` setting lives in
   the plugin secret store (apps/api/src/plugins/v1/secret-store.ts): OpenBao (KV v2, same service as the app
   connectors) when IAM_BAO_ADDR + IAM_BAO_TOKEN are set, otherwise a 0600 file next to the credential file
   (IAM_PLUGIN_SECRETS_FILE to override) - the same storage class as the TOTP/PIN enrollment records, never the
   versioned settings table. A row written before this split keeps working and is scrubbed by the next configure.
   The demo's ephemeral OpenBao token is scoped to the paths it needs (workflow-connections, iam/plugins, a
   read on iam/pg) - scripts/demo-secret-store.test.mjs proves each scope and each refusal.
   Scope: the four NAMED providers (Google, Microsoft, Facebook, GitHub) declare `settingsScope: "plugin"` -
   one provider project per environment, so the client id and secret are set ONCE on the plugin (Plugins >
   Settings or the instance's Edit drawer) and the instance config carries nothing (the New-instance form does
   not re-ask them). The GENERIC OIDC provider stays instance-scoped (several providers, one instance each):
   its `clientSecret` is split out of the versioned config into the plugin secret store under
   `<instanceId>.clientSecret` on save, masked as `********` in every console read (a re-sent mask keeps the
   stored value, an empty string clears it) and merged back only in the server-side runtime paths.
   `openid-client` is a runtime dependency of the API: the demo image prunes devDependencies, and the OIDC
   exchange at the provider callback imports it.
6. **No exploitable demo in real mode**: the simulated screen only exists when no client id is configured, and
   every page and claim says SIMULATED.
7. The sign-in session rules stay: 5 minutes, throttling, generic refusals, fail closed on plugin fault.

## Flow (subject first, then provider - or provider only)

Two shapes exist. **Subject first**: the person enters their account name as today (the subject rules of the
existing flow do not change) and the social step is a later challenge. **Social-only**: a chain whose FIRST step
is a federation step starts without a username - the classic "Sign in with <provider>" button; the entry creates
a subject-less session and the provider identity resolves the account at the callback, through the explicit link
and nothing else. In both shapes a social step renders a **link field** (new core field type `link`: an anchor
button, no input) that the CORE builds itself - the plugin only declares its intent, the core builds the href, so
a plugin can never smuggle a javascript: or http: URL into the page:

1. `auth.prepare` (pure handler) returns the link prompt; the flow session id travels in the payload.
2. The link points at the CORE: `GET /authorize/external?tenant&instance&session`. The gate calls the plugin's
   `auth.external.start` over the bus, validates the answer (`checkStart`: https-or-loopback endpoints only,
   caps everywhere), mints `state` + `nonce` + PKCE verifier, stores them in the session's pending-external
   slot, captures the authorize params as `resume`, and 302s to the provider authorize URL.
3. The provider redirects to the FIXED callback `GET /authorize/external/callback` (env
   `IAM_EXTERNAL_CALLBACK_URL`, registered once per provider). It carries ONLY `code` + the provider's own
   `state` (internal links use `pstate` so a provider answer can never clobber the authorize `state`). The gate
   resolves the sign-in session from the provider state alone, re-validates the captured `resume` params, runs
   the exchange (below), resolves the linked account, calls `auth.external.verify` over the bus, and 302s the
   browser back to the sign-in page with `session=<id>&resume` - the same URL shape as a first pass, so the
   resume replay cannot smuggle new fields.
4. The core resumes the session: next step's challenge, or the normal allow+claims. A provider denial
   (`error=access_denied`) needs no params and just fails the step.

All network code lives API-side in `authn/federation.ts` (plugins stay pure handlers: they return provider
metadata as data and decide ok/deny from the resolved profile). OIDC exchanges go through openid-client
(`idTokenExpected`, exact issuer/audience, expiry, nonce, and `enableNonRepudiationChecks` so the JWKS signature
is ALWAYS verified - v6 only checks claims otherwise); OAuth2-only providers go code -> token -> userinfo with
the plugin's profileMap, an optional e-mails read (GitHub) and an optional token-inspection read judged by the
plugin (Facebook `debug_token`). Bodies capped at 64 KB, 5 s timeouts, fail closed on anything unexpected.
A DEFINITIVE provider refusal (4xx at the token or userinfo read, or GitHub's 200-with-error-payload shape: unknown
client, rejected credentials, bad/expired code) is not a technical failure: the callback denies with an actionable
message (check the client ID, client secret and callback URL) and the audit trail records only the step and the HTTP
status - never the provider's payload. It fires before any account is resolved, so it reveals nothing about
accounts and stays safe at any chain position. A provider 5xx, a timeout or a malformed answer stays a technical
failure: 503, fail closed.

## Pieces (as built)

- core (Rust): `link` field type built by the core; `GET /authorize/external` (302, https-or-loopback provider
  URL only); `GET /authorize/external/callback` (provider state under `pstate` on internal links); DEMO
  simulated chooser page. Tests in authz.rs (53 core tests + bus e2e).
- flow.service: `externalStart`/`completeExternal`/`externalSession`, pending-external sessions, captured
  `resume` params re-validated on the way back; the finish path (`advance`) extracted from `check`; factor
  `other` never counts toward `auth_mfa`. `consoleConfig` masks the instance-scoped secrets for the console,
  `saveConfig` splits them into the secret store, `instanceConfig` merges them back for the runtime payloads
  and the exchange secret comes from the serving plugin's settings (plugin-scoped) or the instance's secret
  store entry (generic OIDC). Chain analyses run each method's verification IN-PROCESS, with the serving
  plugin's settings (and the instance's stored secret) merged in: the verification handlers are config-pure by
  contract, so the console GET fans no per-method bus calls out (a hosted container cannot afford them inside
  the edge proxy timeout) and a plugin-scoped configured provider is not misread as simulated from its empty
  instance config.
- enroll-store: external links per tenant/subject/instance (sub, email, linkedAt), same storage class as the
  other enrollment records (never Dolt).
- plugins: five provider plugins + their refusing bases (a disabled provider fails CLOSED on the slot), pure
  handlers (metadata + decision only), each signed; secrets only as `secret` settings or env.
- authn/federation.ts: `checkStart` (answer validation), `buildAuthorizeUrl`, `exchangeOidc`,
  `exchangeUserinfo` - the only network code of the feature.
- self-service linking: `POST /tenants/:t/auth/me/external-links/:instance` (+ `/complete` for a simulated
  provider) starts a provider round-trip bound to the authenticated member (own one-use state, 5 minutes); the
  fixed callback completes it and the core 302s to the recorded return URL (https-or-loopback, anything else
  becomes a plain confirmation page - never an open redirect). The plugin judges with `intent: 'link'` (its own
  policy applies; an existing link is not required to create one). Unlink is the enrollment DELETE.
- console/profile: a "linked sign-in providers" component per plugin (`screens/profile.mjs`, self: link/unlink,
  admin: status/revoke - an administrator never links for someone else). The New-instance form of a
  plugin-scoped provider asks only the core fields (name, level) and says where the provider project is set;
  every `secret` setting renders as a password input in the console forms.
- in-console setup guide: each provider manifest declares a `setupGuide` (intro, ordered steps, provider
  console + official doc links). The Plugins drawer shows it above the settings form with the exact callback
  URL to register (`IAM_EXTERNAL_CALLBACK_URL` when set, else the console's own origin + the fixed callback
  path), a copy button, a secret-handling warning, and a DEMO MODE chip while the client id is empty.

## Tests (each commit with its tests)

- authz.rs: link field rendering (escaping, https-only, length caps), external start/callback routes, resume.
- external.spec.ts (API, over the bus): catalogue (five types, factor `other`, no `federation` placeholder);
  full SIMULATED chain round-trip (link step, DEMO identities, explicit link, resume); callback resolving the
  session from the provider state alone; external start refused on a non-federation step; social-only chain
  (subject-less entry, resolution at the callback, subject-less POST refused); self-service linking (simulated
  round-trip, the link then signs the member in on the social-only chain, clash refused, one-use state);
  one provider subject per account (409).
- federation.spec.ts (API, loopback fake providers): real OIDC exchange with a jose-signed id_token validated
  through JWKS (wrong key / wrong nonce / wrong verifier / wrong state all refused, PKCE verified provider-side);
  oauth2-userinfo flow with e-mails fallback and token inspection; malformed plugin answers refused.
- bus-routing-coverage and SENSITIVE/grants updated for the two new sensitive hooks.
