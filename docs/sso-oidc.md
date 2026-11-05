# SSO: the platform as an OpenID Connect provider (plugin `oidc-provider`)

Status: step 2 of the SSO plan. Fictional demo data, not production. Needs the `app-connector` plugin (the registry of applications).

## What it does

The platform acts as an **OpenID Provider (OP)**. An application registered in **Applications** (protocol `OpenID Connect`) signs its users in with the authorization code flow and **PKCE (S256, always required)**. The protocol is the embedded library **node-oidc-provider** (MIT, OpenID certified); this plugin only wires it to the platform. Turn the plugin off in Plugins and every endpoint below answers 404, the registry stays untouched.

Endpoints (per tenant, `<base>` is the public API address: `https://<console>/api` in the hosted demo):

| What | URL |
| --- | --- |
| Issuer and discovery | `<base>/sso/<tenant>/oidc` and `/.well-known/openid-configuration` |
| Authorize, token, userinfo (`/me`), JWKS (`/jwks`), revocation, end session | listed in the discovery document |
| Sign-in page for the user | the console, route `/sso-interaction/<uid>` |

Set `IAM_SSO_BASE_URL` to pin the public base URL (the hosted demo does it in `demo/start.sh`). Without it the base is taken from the request (`x-forwarded-proto`/`x-forwarded-host`), which is fine locally and not recommended on a public host.

## The sign-in, step by step

1. The application sends the browser to `authorize` with `code_challenge` (S256), `redirect_uri` (exactly one registered), `scope`, `state`.
2. The platform redirects to the console page `/sso-interaction/<uid>`. The console requires its normal sign-in, so the user goes through **the authentication chain** configured in Authentication methods (password, codes, MFA...). The OIDC library never sees a password.
3. The page names the application and what it receives (from the scopes) and asks **Allow / Cancel**. A user without one of the application's **allowed roles** only sees a refusal.
4. The browser returns to the application with a code; the application exchanges it (with its `code_verifier`) for an ID token, an access token and, with `offline_access` and `prompt=consent`, a refresh token (rotated at each use).

## Who may open an application (closed by default)

The decision is taken on the **live** data (Dolt main), not on an unapplied branch: the application must be **enabled** and the user must hold **at least one of its `allowed_roles`**. An empty list means nobody. A refusal ends with `access_denied` at the application and an `sso.login.denied` event. (Moving this decision into the Rust core as a Cedar check, and the blocking `sso.authorize.check` event, are later steps.)

## What the application receives

`attribute_mapping` of the application maps a **claim name** to a **profile key**:

- profile keys: `id`, `email`, `display_name`, `department`, `roles`
- claims that can be sent: `sub`, `email`, `email_verified`, `name`, `preferred_username`, `department`, `roles`, `groups`

Any other claim name is ignored, and a claim whose profile value is empty is left out. Only the claims the application mapped are sent (a claim not mapped is never sent, whatever the scope). `email_verified` is always `false`: the directory does not verify addresses. Scopes: `openid`, `profile`, `email`, `roles`, `offline_access`.

## Secrets and keys

- **Client secret**: the application's `secret_ref` names an entry in the secret store (OpenBao, field `client_secret` or `value`). If it can be read, the application is a *confidential* client (`client_secret_basic`). If there is no secret store or the entry is missing, it is a **public client**: no secret, PKCE is what protects the code. The seeded demo has no secret store, so its applications are public clients.
- **Signing key**: read from the secret store (`sso/<tenant>/oidc-signing-key`, field `jwk`, a private ES256 JWK) so it survives restarts. Without one, a key is **generated at each start** (ES256): tokens issued before a restart cannot be verified afterwards. Only the public key is published (JWKS).
- Sessions, codes, tokens and grants are **in memory** (runtime state, not Dolt), so they are lost at restart. Cookie keys: `IAM_SSO_COOKIE_KEY` (16+ characters) or random at start.

## Events and audit

`sso.login.succeeded`, `sso.login.denied`, `sso.login.failed`, `sso.token.issued` (payload: `app`, `subject`, and `reason` or `scope`), in the workflow trigger catalogue. They are also written to the decision audit (`action` = event type, `resource` = `app:<id>`). No token and no claim value is stored.

## API for the console (signed-in user)

```
GET  /sso/:tenant/interaction/:uid            -> { app, scopes, user, allowed }
POST /sso/:tenant/interaction/:uid/complete   { decision: "allow" | "deny" } -> { redirectTo }
```

A branch-test token is refused. The unguessable `uid` and the browser's own resume cookie tie the answer to the browser that started the request.

## Try it

1. Enable Application connectors and OpenID Connect provider (Plugins). Both are enabled in the seeded demo.
2. Register an application (or use `wiki`), with its `redirect_uris`, `allowed_roles` and mapping; enable it; Apply the branch.
3. Point the application (or any OIDC client library) at the issuer URL. With `openid-client`:

```ts
const config = await oc.discovery(new URL(issuer), 'wiki', undefined, oc.None());
const url = oc.buildAuthorizationUrl(config, { redirect_uri, scope: 'openid email', state, code_challenge, code_challenge_method: 'S256' });
```

### Zero-install test client

`demo/oidc-test-client.mjs` is a tiny local application (Node 18+, no dependency, no secret) that runs the whole flow against any issuer and prints the tokens and the userinfo answer:

```sh
node demo/oidc-test-client.mjs https://<host>/api/sso/acme-demo/oidc wiki
```

It listens on `http://localhost:4300/callback` (registered on the seeded `wiki` application, whose `allowed_roles` include `employee`, held by `demo-alice` and `demo-bob` in the seeded demo). Open the URL it prints in the browser where the console is signed in, answer Allow on the consent page, and the terminal shows the decoded ID token, the access token and the userinfo claims. On the free host the first call can wait a minute for the cold start; the client retries on its own.

## Tests

- `apps/api/src/sso/oidc.spec.ts`: a local relying party (openid-client) runs the whole flow against the embedded provider: consent, code exchange, ID token, userinfo with mapped claims only, refresh rotation, `access_denied` for a user without role, decline, no PKCE, wrong `redirect_uri`, disabled or unknown application, wrong PKCE verifier, single-use code, the plugin off (404), and an edge that strips `/api`.
- `apps/web/src/app/sso-interaction.spec.ts`: consent wording.
- Not covered locally: the Dolt directory (`DoltSsoDirectory`, reads `identities` and `assignments` on main) runs in the real-Dolt CI only through the seeded demo; the OpenID conformance suite is not run (option for later).

## Not done yet

Per-application consent memory, front-channel/back-channel logout, dynamic client registration (clients only come from the registry), the Cedar access decision in the core, key rotation, SAML (next step), federation, SCIM.
