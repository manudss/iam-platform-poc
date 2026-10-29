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
3. **Simulated steps do not count.** Unless the server is configured for real SMTP (below), the e-mail code goes to a **demo outbox** that administrators can read, and the sign-in page says so ("DEMO ONLY: no e-mail is sent"). It proves nothing about owning a mailbox. A chain with a simulated step gets an `effectiveLevel` capped by the best really verified step, and the step is listed in `auth_simulated` and left out of `amr`.
4. A TOTP secret provisioned by an administrator in the demo is known to that administrator: a real product enrolls from the user's own session.

## Claims in the id_token

`amr` (really verified methods only), `auth_level` (effective), `auth_level_declared`, `auth_level_basis` (`configured`), `auth_mfa`, `auth_chain`, `auth_methods`, `auth_simulated`. Only this whitelist is copied from the gate to the token. Later, services can require a minimum `auth_level`; that check is not built yet.

## Method types

| Type | Factor | State |
| --- | --- | --- |
| Password | knowledge | real, through the base password slot (lockout still applies) |
| Authenticator app (TOTP, RFC 6238) | possession | real verification (tested on RFC vectors, a used time step is refused again); demo enrollment by an admin |
| One-time code by e-mail | possession | **simulated** (demo outbox) by default. **Real** only when the method's delivery is `SMTP` and the server has `IAM_SMTP_*` set; then it counts as a verified possession factor |
| PIN on a shuffled keypad | knowledge | real verification of a whole PIN (scrypt hash) |
| Passkey, recovery codes, external IdP | | catalogue entries only, cannot be created |

### PIN on a shuffled keypad

Requirement from the product owner: a numeric PIN typed with on-screen buttons shown in a different order each time, with the small letters of a phone keypad, where each button carries a code the backend decodes, so the PIN digits are not sent in clear.

- Every page shows the 10 digits in a new random order. Each button is a form submit whose value is an **opaque id valid for that page only**; the server keeps the id-to-digit map in the sign-in session and the digits entered so far. One press is one POST (no JavaScript: the sign-in pages have a strict CSP).
- An id the page did not carry (replayed or forged), more than 40 presses, a wrong length or a wrong PIN ends the attempt. Submitting needs exactly the configured number of digits (4 to 8, default 6). Wrong PINs count toward the per-step tries and the per-account throttle.
- Only a salted scrypt hash of the whole PIN is stored, outside Dolt. No per-position verifiers, no pepper, no clear PIN, and the PIN is never returned by the API.
- **This is obfuscation, not encryption.** It keeps digits out of simple form logs and screen scrapers of the posted data, nothing more: anyone who can read the page and the session (or malware on the device) sees the mapping. HTTPS is required. A 4 to 8 digit PIN can be brute forced offline by anyone who gets the hash file. This is a POC with fictional PINs, not a bank-grade authentication.
- The page deliberately has no fingerprint button and no working "forgot" link: only what is implemented is shown.

### E-mail codes

- The address comes from the **user profile** (new `email` column of `identities`, edited on the Users page, versioned on the working branch and live after Apply). The demo enrollment address is only a fallback.
- First step: the page asks for the user name and answers the same way whether the account exists or not; an unknown account gets the page and no message. Later step: the already identified account's address is used, nothing is asked again.
- Real delivery is **configured only by server environment**, never in the console or the database: `IAM_SMTP_HOST`, `IAM_SMTP_FROM` (required, no default sender), `IAM_SMTP_PORT` (587), `IAM_SMTP_SECURE` (`1` for implicit TLS), `IAM_SMTP_USER`, `IAM_SMTP_PASS`. No provider, sending domain or sender identity is chosen by the code. Until they are set, a method set to `SMTP` stays simulated and says so.
- A delivery failure is logged on the server (without the code) and never shown on the page.
- Tested: message construction and recipient filtering through the mail transport, routing to the profile address, claims. **Not tested against a real SMTP server.**

## Sign-in flow

First step failure is a generic denial and an unknown user gets a decoy flow (no account enumeration). Later steps allow 3 tries. Sessions last 5 minutes; a code or keypad id is valid for one page or one use. Throttling: 10 failures and 30 starts per 10 minutes per account. The JSON `/authorize` path cannot run multi-step chains and denies them; use the browser flow.

## API (tenants/:t/auth, sign-in required, writes need the admin capability and a working branch)

`GET /`, `POST /analyze` (draft check), `PUT /`, `GET|POST enrollments/:user(/:instance)`, `DELETE enrollments`, `GET|DELETE outbox`. The gate adds `POST /internal/auth/entry` and session answers on `authenticate`.

## Known limits

No SMS, no real e-mail until an SMTP provider is configured and tested, no passkeys, no service-level gating by `auth_level` yet, no self-service enrollment, a single `core-authn` document per tenant, mobile console layout reuses the existing shell.

## Ready-to-try examples (seed)

When nothing is stored yet on a branch, the console shows every executable method type (password, authenticator app, e-mail code, PIN keypad, a second PIN with 8 digits) and five example chains, so nothing has to be created by hand. This is a display default: nothing is written until an administrator presses "Save on this branch", and no chain is selected for sign-in, so live sign-in does not change until a chain is chosen, saved and applied. An existing stored configuration is never replaced. Catalogue-only types (passkey, recovery codes, external IdP) are not seeded. The e-mail step stays simulated unless SMTP is configured.

"Provision demo credentials for demo-alice" (after saving) enrolls the fictional demo user in every method that needs it: the authenticator secret and generated PINs are shown once on screen. Enrollments are never seeded or versioned and no real credential is created.

The console disables Save, "Add method" and the starter set until the configuration has finished loading, so a late response cannot overwrite edits.
