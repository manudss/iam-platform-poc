# Hooks journal (plugin `hooks-journal`)

Optional plugin that records plugin hook calls and shows them as a timeline: which plugins **could** answer a hook and which one **did**.

## Enable
Plugins screen: install `hooks-journal`, then enable it (admin only). Until then nothing is recorded and the API answers 403. Disabling stops recording.

## What is recorded (real instrumentation only)
- **Plugin registry hooks**: `callSlot` and `emit` in `plugins/v1/registry.ts` call `observe()` once per call: hook name, slot, mode, candidate plugins, plugins that answered, outcome (`ok`, `fell-back`, `refused`, `error`, `no-consumer`), duration, masked payload.
- **Business events (AppEvents)**: NOT instrumented in this PR. `AppEvents` exists only in PR #7 (workflows), not on `main`. Follow-up after that merge: one call in `AppEvents.emit` to `journalStore.record({ kind: 'app-event', mode: 'event', candidates: <listeners>, answered: <handlers that ran>, ... })`. The UI already has the `app-event` kind filter; it stays empty until then.

## No invented history
The journal only contains calls made while the plugin is enabled. `recordingSince` is the time of the first recorded call (null before any call). Earlier periods are empty, never reconstructed. The store is bounded in memory; set `IAM_JOURNAL_FILE` to also append JSON lines (survives restarts).

## Player ("replay" = watching the history again)
The page plays the chosen period like an accelerated video: play/pause, speed (x1 to x30; at x1 the whole period lasts 60 s), a position slider, previous/next call, and a detail card for the current call (who could answer, who answered, masked data). Use it to follow what happened, debug, or understand a problem (for example why an access was refused). It never calls a hook again.

## "Replay" = reading
The screen and API are read only (`GET /tenants/:tenant/journal/entries`, `/summary`). Nothing re-emits a hook or event, answers a request or assigns a role. A replay with effects would be a separate mode needing explicit confirmation.

## Privacy and access
Admin only (AuthGuard + AdminGuard), per tenant. Payloads are masked before storage: keys such as token, password, secret, authorization, cookie, api key are replaced; emails are partially masked; free text is scrubbed of token-like strings.

## Tests
`apps/api/src/journal/journal.spec.ts` (masking, store, registry observation), `journal.http.spec.ts` (403 when off, enabled flow, validation, no write route), `apps/web/src/app/journal.spec.ts`.
