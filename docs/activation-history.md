# Activation status and history

The Activation page is read-only. Opening it, refreshing it or expanding an entry never activates,
reconciles, merges or publishes anything.

## Sources and meaning

- **Live permission engine**: GET `/tenants/:tenant/activations/status` reads the core's
  `/v1/version` and Dolt main independently. A matching journal row is highlighted only when both
  sequence and commit match the core's answer. A failed latest publication never replaces this fact.
- **History**: GET `/tenants/:tenant/activations/journal`, newest first in the UI, with a state filter.
  Both detailed reads require authentication, the administrator capability, the activation screen
  right and the configured administration assurance level. The legacy GET `/activations` keeps
  returning only sequence and commit, without exposing the new audit metadata to ordinary users.
- `recordedAt` is the journal's server timestamp (`activated_at` in PostgreSQL), not the data commit
  date and not a claim that publication succeeded.
- `appliedAt` is the last successful core confirmation recorded by the API. Reconciliation can update
  it without creating a new activation. It is not a durable history of each reconciliation attempt.
- `actor` is the original initiator captured at a trusted server entry point: signed-in subject for
  direct activation, Apply and human PR publication, workflow identity for workflow publication,
  or `startup-main` for automatic startup publication. Request bodies cannot supply it. A retry keeps
  the first request's actor. Older records and paths without attribution (including the legacy
  Temporal activation route) show unavailable, never the Dolt committer as a substitute.
- Expanded entries read the existing administrator-only Dolt commit and diff APIs. The interval is
  the preceding *journal entry* to this entry, not necessarily two successfully live versions.
  It shows net changed tables, change type, row counts when available and schema-change flags.
  No row values or credential material are fetched. Those details still require the separate Dolt
  history/compare permissions. Lack of permission or a missing commit is shown explicitly.

## Persistence and limitations

PostgreSQL adds nullable `actor_id`, `actor_kind` and `applied_at` columns. Existing `activated_at`
values are exposed as-is. No old actor or successful-apply timestamp is backfilled. There are no
changes to Dolt business data, core snapshots, sequence allocation or publication guards.

Without PostgreSQL the development journal remains in memory and is lost at API restart. The core
may still have an active version absent from that journal; the page says so. The first known entry
has no predecessor, so its initial diff interval is unavailable. The UI displays dates in the browser's
timezone. Refresh is manual, with the observation time shown; there is no hidden polling.

## Checks

- `cd apps/web && npm test -- --watch=false` and `npm run build`
- `cd apps/api && npm run build`
- `PG_BIN=<postgres-bin-dir> node --test dist/pg.e2e.spec.js dist/activation/activation-audit.spec.js dist/activation/activation-http.spec.js dist/auth/screen-guard.spec.js dist/branding/contrast.spec.js dist/branding/css-contract.spec.js`
- Full integration coverage is the repository CI, which supplies the core, NATS, Dolt and other
  service binaries. A local test run without those binaries is not a full green integration run.
- Render the actual built console with isolated fictitious HTTP fixtures in desktop/mobile,
  light/dark, default/teal themes. This does not validate a deployed demo or send any mail.
