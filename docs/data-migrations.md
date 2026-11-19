# Versioned application data migrations

The demo image no longer runs the complete seed at every boot. `/data/migrations/journal.json`
is the persistent application migration ledger. It is included in the existing cold `/data`
backup. This ledger is separate from each plugin's existing installation migration ledger.

## Startup contract

* A new `auto` preview imports `data/migrations/0001-initial.sql`, then runs the frozen
  initial authentication/enrollment, directory, organizations, profiles, application and
  workflow initialization. Only a successful verification records version `0001`.
* A populated dataset without a ledger refuses startup. It is **not** seeded or automatically
  declared current. See adoption below.
* `never` still refuses an empty dataset. On a tracked populated dataset it runs only
  missing migrations, never the initial seed again.
* The exclusive `/data/.boot.lock` is held for the entire container lifetime. Offline adoption
  takes the same lock. Do not bypass the launcher or run another writer on the volume.
* Every boot validates frozen source checksums and the complete ordered ledger. Unknown
  newer versions, gaps, changes to applied files and unreadable state refuse startup.
* Before a migration writes, an atomic, fsynced pending record stores its version, boot ID
  and phase. Failure or process death retains it. A new boot refuses to retry the partial
  work. There is no automatic reset, pending-marker deletion or blind seed retry.
* Workflow cron, sheet polling, workflow resumption, application event deliveries and
  activation effects cannot race the migration barrier. The HTTP listener and edge do not
  open before initialization, migration verification and publication succeed.

The initial migration freezes seed records and routines in `apps/api/src/migrations/v0001/`.
It calls ordinary storage/plugin APIs, so this is not a second frozen copy of the entire
application. Changes to those APIs still require compatibility tests on a new baseline and
on an existing customized dataset. Runtime storage `CREATE IF NOT EXISTS` safeguards are
not a replacement for future versioned changes to application data or schema.

## One-time adoption of an existing Oracle dataset

No live Oracle action is performed by this code change. Keep deployments paused until the
exact image and recovery procedure have been qualified on a **complete isolated copy**.
The old seed writes credentials, configuration, profiles, plugin enablement and workflows;
permission to replay once is not permission to overwrite existing choices. Adoption avoids
that replay entirely.

1. Hold an independent front maintenance barrier and stop the application. Follow the
   existing cold backup/recovery procedure in `docs/oci-deploy.md`: `/data` including all
   Dolt databases, branches and dirty roots, credentials/enrollments, core state/NATS,
   PostgreSQL journal/audit and OpenBao store/keys, plus deployment configuration. Verify
   archives/checksums and prove restoration on an isolated stack. A nonempty MANIFEST
   alone does **not** prove recoverability.
2. Use the exact candidate image with its normal entrypoint overridden to `sh`, the copied
   dataset mounted at `/data`, and NO network access to production companion services.
   Run `sh /app/demo/data-migrations.sh plan-adoption /data/adoption-plan.json /recovery/MANIFEST`.
   This only reads Dolt and writes a private plan. It requires recognizable baseline tables
   and directory columns; it fingerprints **every branch working root and head in every
   user database**, including uncommitted personal work. Errors are unknown, never empty.
3. Review the plan against the verified cold backup and current customized baseline.
   Missing expected schema means stop and investigate; do not seed to make the check pass.
   Missing fictional rows can be intentional user edits and do not authorize inserting them.
   The command does not inspect external PostgreSQL/OpenBao recovery contents for you.
4. On the qualified copy first, then only in the coordinated approved production operation,
   run `sh /app/demo/data-migrations.sh adopt-existing-v1 /data/adoption-plan.json --confirm-reviewed-backup-and-existing-v1`.
   It rechecks the backup manifest hash and all branch roots/heads, and only writes an
   `adopted` ledger entry. No business SQL, seed method or credential write runs.
5. Boot the candidate with `IAM_DEMO_SEED_MODE=never`. Check the ledger has no pending entry,
   application login/plugin behavior, all hostnames, journal/audit and secret preservation,
   personal branches/dirty work and the rollback path before lifting the independent gate.

These commands must run while the old application is stopped. Older images do not take the
new lock; the lock alone cannot stop an older running application or an external SQL writer.
Do not copy a plan between unrelated datasets. Keep the private plan with recovery evidence.

## Adding version 0002 and later

1. Add a new version directory and an action factory with explicit `run` and `verify`.
   Append its factory to `migrations/boot.ts`; never edit `v0001` or any released version.
2. Append a consecutive four-digit manifest entry with the exact source-file SHA-256s and
   checksum of its JSON `files` object. Include all migration-specific SQL/data/code files.
   Run `node scripts/data-migrations.mjs --base origin/main`. CI and Docker verify checksums;
   CI also rejects alterations to released manifest entries.
3. Choose scope explicitly: business Dolt main, **every existing business branch** if a schema
   change needs it, unversioned meta, PostgreSQL and/or persistent credential storage.
   Never silently update only main when personal branches need the new schema. Never
   check out/reset/delete a branch, or treat a missing/unauthorized read as absence.
4. Test fresh `0001 -> ... -> new`, adopted customized data `0001 -> missing only`, second
   boot no-op, dirty personal branches, checksum drift, injected apply/verify interruption,
   and whole-stack cold restore. New demo records are migrations too, with a collision
   policy that preserves edited records rather than replacing them by default.
5. Keep the pending record on failure. Restore the **whole consistent pre-update backup**
   (data + PostgreSQL + OpenBao/configuration as applicable) before booting the previous image.
   Restoring only the image can corrupt or misread a migrated dataset. There are no
   automatic down migrations and no cross-Dolt/PostgreSQL/filesystem transaction claim.

Qualification: the unit journal tests and real Dolt CLI tests cover ordering, no replay,
explicit adoption, drift on a dirty personal branch and interrupted restart. The full boot
integration test uses real Dolt + Rust core + NATS, runs the complete initial API seed and
checks a second boot preserves customized names, credential/enrollment files and branch
heads/dirty roots. Those services are required in CI; unavailable local binaries are reported
as a missing full-stack check, not a successful qualification.
