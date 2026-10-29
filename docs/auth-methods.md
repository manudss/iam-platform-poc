# Authentication methods and chains

Status: working POC slice. Code: `apps/api/src/authn/`, gate protocol in `core/crates/iam-core/src/{gate,authz}.rs`, console page `apps/web/src/app/auth-methods.*`, browser test `scripts/auth-methods-e2e.mjs`.

## What it does

- Each authentication method is a **plugin type** (password, authenticator app, e-mail code, digit code). A type can be added **several times** with different settings (for example two digit codes, or two TOTP instances with different digits).
- An administrator lists the **method instances**, orders them, enables or disables them, sets a **level from 1 to 10 (10 = strongest)** on each and creates new ones from the catalogue.
- A **chain** is an ordered list of method instances run by the core at sign-in. Every step must succeed. The core owns the chaining: plugins only verify one step.
- All of it is stored as a `core-authn` settings entry of the plugin registry, so it is versioned on the Dolt working branch and becomes the live sign-in only after **Apply**. Until then the classic login form is unchanged. Enrollments (TOTP secret, PIN hash, e-mail address) are **not** versioned and live in a file outside the database (`IAM_AUTHN_FILE`).

## Honesty rules (read before using the levels)

1. **Levels are declared, not measured.** The level on a method or chain is what the administrator decides. It is never summed across steps. A chain level must be at least its strongest step; that is a sanity bound, not a scientific rule. The console "Suggest level" button proposes the strongest step as a starting point only.
2. **More steps are not more factors.** The chain is `mfa: true` only when at least two **different factor categories** (knowledge, possession, inherence) were really verified. Two knowledge steps (password then PIN) are two steps, one factor category.
3. **Simulated steps do not count.** The e-mail code goes to a **demo outbox** that administrators can read. It proves nothing about owning a mailbox. A chain with a simulated step gets an `effectiveLevel` capped by the best really verified step, and the step is listed in `auth_simulated` and left out of `amr`.
4. A TOTP secret provisioned by an administrator in the demo is known to that administrator: a real product enrolls from the user's own session.

## Claims in the id_token

`amr` (really verified methods only), `auth_level` (effective), `auth_level_declared`, `auth_level_basis` (`configured`), `auth_mfa`, `auth_chain`, `auth_methods`, `auth_simulated`. Only this whitelist is copied from the gate to the token. Later, services can require a minimum `auth_level`; that check is not built yet.

## Method types

| Type | Factor | State |
| --- | --- | --- |
| Password | knowledge | real, through the base password slot (lockout still applies) |
| Authenticator app (TOTP, RFC 6238) | possession | real verification (tested on RFC vectors); demo enrollment by an admin |
| One-time code by e-mail | possession | **simulated delivery** (demo outbox); an adapter interface exists, no real mailer is wired |
| Digit code | knowledge | real verification; the whole PIN or digits asked at random positions |
| Passkey, recovery codes, external IdP | | catalogue entries only, cannot be created |

### About the "bank-style digit code"

The exact meaning is not confirmed with the product owner. The POC implements an enrolled PIN entered in full or as a few digits at random positions. A PIN is stored as a scrypt hash plus per-position HMAC verifiers keyed with a server-side pepper (so positions can be verified). This is weaker than a clean hash: a 4 to 8 digit space can be brute forced by anyone who gets the file and the pepper. Do not use a real PIN. Treat it as a demo of the chain mechanism; a production design would use an HSM-backed or one-time-code approach, and collect a PIN only through an out-of-chat enrollment.

## Sign-in flow

First step failure is a generic denial and an unknown user gets a decoy flow (no account enumeration). Later steps allow 3 tries. Sessions last 5 minutes. Throttling: 10 failures and 30 starts per 10 minutes per account. The JSON `/authorize` path cannot run multi-step chains and denies them; use the browser flow.

## API (tenants/:t/auth, sign-in required, writes need the admin capability and a working branch)

`GET /`, `POST /analyze` (draft check), `PUT /`, `GET|POST enrollments/:user(/:instance)`, `DELETE enrollments`, `GET|DELETE outbox`. The gate adds `POST /internal/auth/entry` and session answers on `authenticate`.

## Known limits

No real e-mail or SMS, no passkeys, no service-level gating by `auth_level` yet, no self-service enrollment, a single `core-authn` document per tenant, mobile console layout reuses the existing shell.
