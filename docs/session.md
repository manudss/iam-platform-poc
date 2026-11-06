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

## Renewal

`POST /core/session/extend` with the current token returns a fresh one for the same sign-in (same `auth_time`, new `iat`/`exp`).
- 401: token invalid or expired. 409: `session_max` reached. Success emits the bus event `session.extended`.
- No password is asked again, and the sign-in time is never moved, so the maximum length cannot be bypassed.

## Console

`<app-session-timer />` (apps/web/src/app/session-timer.ts) is self-contained and reads only the `Session` service, so it can sit in any bar. It shows the time left and a bar that empties as time runs out. In the warning window a dialog offers "Stay signed in" or "Sign out now". When the limit is reached it says so and cannot extend.

## Tests and how to try it

- Rust: `cargo test -p iam-idp -p iam-core`. API: `npm test` in apps/api (`session.spec.ts`). Web: `ng test` (`session-timer.spec.ts`).
- Browser: `scripts/session-extend-e2e.mjs` (real Dolt, core, API, Chrome; 20 s token): bar goes down, dialog, renewal, still signed in past the first expiry, then expiry.
- By hand: set `ttlSeconds` to 60 and `warnSeconds` to 20 in Authentication methods, sign in, wait for the dialog.
