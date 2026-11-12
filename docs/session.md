# Session length, timer and "Stay signed in"

The console session is the signed ID token the core issues at sign-in. This feature makes its length configurable, shows the time left, and lets the person renew it before it ends.

## Configuration (per tenant, on Dolt)

Stored in the tenant's core settings under the key `core-session`, so it is branchable: change it on a branch, review it in Review & Apply, and it is live after Apply.

| Field | Default | Meaning |
|---|---|---|
| `ttlSeconds` | 1800 | Length of one token. |
| `warnSeconds` | 120 | The warning dialog opens this long before the end (never more than a third of the token life). |
| `maxSeconds` | 28800 | Hard limit since the password sign-in. Renewals stop there. |
| `allowExtend` | true | Offer "Stay signed in". |

`IAM_TOKEN_TTL_SECS` stays an operator ceiling: the tenant value can never exceed it.

API: `GET /tenants/:tenant/session` (effective values), `PUT /tenants/:tenant/session` (admin token, body `{config}`).
Console: Authentication methods, section "Session".

## Persistence

The durable copy of the console session is the `iam_session` cookie the hosted edge sets when it proxies a
successful token exchange (`POST /token`, also on renewal): `HttpOnly` (JavaScript cannot read it), `Secure`,
`SameSite=Lax`, `Path=/`, `Max-Age` = the token's own `exp`. Coming back to the console - or answering an SSO
sign-in request, which rides the console session - within the token's lifetime skips a new sign-in, because the
console re-reads the cookie through `GET /session/bootstrap` (same-origin fetch with a custom header, so no
cross-site page can pull the token) and keeps the token in memory only. `POST /session/logout` clears the cookie
at sign-out; an expired token is never restored (the server verifies every request anyway). With `allowExtend`
off, the session simply ends at `ttlSeconds`.

Why a cookie when the token already rides `Authorization: Bearer`? A browser never adds `Authorization` to a
document request, so the server-side render of the console cannot see the session that way; a cookie is the only
transport that travels with page loads. The cookie never authenticates API calls (they keep their Bearer header),
so no CSRF surface is added; the two console session endpoints that read it require an `X-Requested-With` header
on top of `SameSite=Lax`.

This is also what lets the server render **My applications** (`/my-applications`): the render adopts the cookie
token, fetches the launchpad through the edge and ships the cards in the first HTML. A document request without
a cookie redirects to `/login`; `/` redirects to one or the other depending on the cookie.

In local development (`ng serve`, no edge) there is no cookie: the token is kept in localStorage (`iam.session`)
instead, with the same restore rules as before.

## Renewal

`POST /core/session/extend` with the current token returns a fresh one for the same sign-in (same `auth_time`, new `iat`/`exp`).
- 401: token invalid or expired. 409: `session_max` reached. Success emits the bus event `session.extended`.
- No password is asked again, and the sign-in time is never moved, so the maximum length cannot be bypassed.

## Console

`<app-session-timer />` (apps/web/src/app/session-timer.ts) is self-contained and reads only the `Session` service, so it can sit in any bar. It shows the time left and a bar that empties as time runs out. In the warning window a dialog offers "Stay signed in" or "Sign out now". When the limit is reached it says so and cannot extend.

## Tests and how to try it

- Rust: `cargo test -p iam-idp -p iam-core`. API: `npm test` in apps/api (`session.spec.ts`). Web: `ng test` (`session-timer.spec.ts`, `session-persistence.spec.ts`). Edge: `node --test demo/*.test.mjs` (`server.test.mjs`: cookie issue, renewal, bootstrap, sign-out, document-route redirects).
- Browser: `scripts/session-extend-e2e.mjs` (real Dolt, core, API, Chrome; 20 s token): bar goes down, dialog, renewal, still signed in past the first expiry, then expiry.
- By hand: set `ttlSeconds` to 60 and `warnSeconds` to 20 in Authentication methods, sign in, wait for the dialog.
