# Account blocks and authentication levels

## Blocks

An account can carry several blocks at once: `suspended`, `disabled`, `locked` (too many failed answers), `pending_approval`, `pending_verification`. Each has a type, a message set by whoever blocked, an author, a date and optionally an end time (`until`) or `hold` (kept until someone or a workflow lifts it). The highest-priority block in force is the one shown.

Sign-in refuses an account that carries a block in force **after the first factor succeeded**. Before that the answer stays the generic "Sign-in failed", so nobody can learn which accounts exist. The refusal carries the block type, its message and a short reference.

Who may set or lift blocks: the right is the screen `account-blocks`, granted by a Cedar `screen:open` rule (`screen-account-blocks`: administrators and managers for now). Whoever holds it can block or unblock anyone else, whatever set the block. Two protections stay: nobody blocks themselves, and the last active administrator cannot be blocked.

API (admin guard, so the policy engine asks for `account-blocks`):
- `GET tenants/:t/account-blocks`
- `POST tenants/:t/accounts/:subject/blocks` `{kind, message, until?, hold?}`
- `DELETE tenants/:t/accounts/:subject/blocks/:id`

Events for workflows: `user.blocked`, `user.unblocked` (`subject`, `kind`, `actor`).

## Two kinds of state

| | Where | Why |
|---|---|---|
| Settings (`core-security`: lockout values, admin level, per-application levels, hold after approval) | Dolt, on the working branch, live after Apply | Reviewed like any configuration. |
| Blocks (who is blocked, by what, until when) | `iam-poc-account-blocks.json`, mode 0600, atomic write, next to the credential and enrolment files | Operational. An unblock, a verification or an automatic lock must not be undone by an old branch or a rebase, and a failed sign-in must not make a Dolt commit. |
| Failed-attempt counters | Memory of the API process | Transient. |

Durability: the blocks file sits in the same directory as `credentials.json` and the enrolments (`core-state/`), so it lives on the same volume and has the same backup and migration path. It is listed in `deploy/oci/qualification.policy.example.json` with the other state files.

Limits, stated plainly: the file store is single-writer, like the credentials and enrolments around it. Failed-attempt counters are per API process: with several processes the effective threshold is higher than configured. The automatic lock is a brake on guessing, not a guarantee.

## Automatic lock

On by default with the owner's starting values: 5 failures in 15 minutes lock the account for 15 minutes. Every value is configurable (`lockout.enabled`, `maxFailures`, `windowSeconds`, `lockSeconds`, `hold`, `exempt`). Only known accounts are locked. While locked, answers are not evaluated.

## Levels

- Administration pages: `adminMinLevel` (and optional `adminMaxAgeSeconds`). Below it, a 403 `{code: 'step-up-required', requiredLevel, currentLevel}`. 0 turns the rule off. Demo target: 5.
- Applications: `appLevels.<app id>.minLevel` (demo target: finance 8), checked before consent and when the request is completed. The interaction details carry `assurance`, with the chains the person can use.
- `GET tenants/:t/me/step-up?level=N` lists only chains that reach the level, have no simulated step and that the person has set up. Never a weaker one.
- The level of a federated provider is a value an administrator declares. Lyam cannot measure a provider's safety.
- Raising `adminMinLevel` is refused unless the person saving holds that level in their current session, and a chain reaches it, so the change cannot lock them out.
