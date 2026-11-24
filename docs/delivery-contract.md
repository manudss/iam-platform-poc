# Candidate delivery contract

This work is not ready to merge until the real jobs and independent review pass.
The stable aggregate check is `Delivery contract`, in Demo image (GHCR).
The existing image build produces one exact candidate digest. Both scenarios
consume that same digest, with the scripts checked out at its exact source SHA.
No production account, volume, host or provider secret is used.

- `delivery_regressions`: fail-closed aggregator mutations and all candidate
  Python deployment-control unit tests. These tests alone prove no real delivery.
- `delivery_fresh`: real image boot, helper confinement, real synthetic services,
  actual qualifier auth/ledger check and UI document check.
- `delivery_upgrade`: a persistent fictional dataset from immutable image 310,
  candidate ordered queue and unmodified update.sh, preservation qualification,
  then real closed updater receipt and candidate receipt consumer.
- `delivery_contract`: always runs, requires the exact set of successful jobs,
  exactly two scenario receipts, exact source/digest identity, complete checks,
  evidence hashes and successful cleanup. Missing, skipped, cancelled or failed
  jobs and missing receipts fail. No continue-on-error or branch/path exceptions.

Known boundaries and dependencies:

The candidate starts from main, not a combination of incident draft branches.
If main lacks a receipt consumer or still has a qualifier defect, the job must
fail and retain its stage. Draft fixes are never silently fetched over it.
The first run may expose harness problems; a red result is not automatically
proof of a product problem. Reports must distinguish these cases.

The fixed image 310 is the initial old-data baseline only, never the candidate.
It must be reviewed and advanced deliberately as deployment support changes.
Synthetic Bao runs with the real durable server configuration. Cold backup
readback of Dolt, PG, Bao and recovery bundle is checked. Semantic restore
rehearsal on a fresh stack is NOT yet covered. UI HTML is not a visual desktop/mobile review. Neither limitation is
a production qualification, availability guarantee, or rollback guarantee.

Root-owned fixture paths use a private mount namespace rather than chmod of
shared /opt. Synthetic env, logs, authentication values and private snapshots
are not uploaded. Artifacts contain sanitized stage results and hashes only.
Ordinary Ubuntu standard runners are used; no paid runner is requested. This
public repository's standard runner compute is free under GitHub's documented
public-repository rules. Artifact retention is three days. No spending setting
is changed. Render quotas are unrelated.

Branch protection is a separate action after check registration and validation.
This change never merges a PR, publishes latest, deploys production, unpauses
updates, or changes production data.
