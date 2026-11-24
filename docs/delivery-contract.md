# Candidate delivery contract

This work is not ready to merge until the real jobs and independent review pass.
The stable aggregate check is `Delivery contract`, in Candidate delivery.
On pull_request, a dedicated delivery image build uses GitHub's merge candidate SHA
(the PR merged with its current base), not the isolated head. It produces one
exact candidate digest. The ordinary preview-head image workflow remains
unchanged; this contract never reassigns its head-SHA tags or moving PR tags.
Both scenarios
consume that same digest, with the scripts checked out at its exact source SHA.
No production account, volume, host or provider secret is used.

- `delivery_regressions`: fail-closed aggregator mutations and all candidate
  Python deployment-control unit tests. These tests alone prove no real delivery.
- `delivery_fresh`: real image boot, helper confinement, real synthetic services,
  actual qualifier auth/ledger check, UI document check, and authenticated
  desktop/mobile Chromium screenshots through natively trusted TLS.
- `delivery_upgrade`: a persistent fictional dataset from immutable image 310,
  candidate ordered queue and unmodified update.sh, preservation qualification,
  plus refusal tests with resume-required format2/3 state and a fixture pause,
  then a real closed updater receipt. The incident-specific opening consumer
  is tested separately when present, not required when absent from main.
- `delivery_contract`: always runs, requires the exact set of successful jobs,
  exactly two scenario receipts, exact source/digest identity, complete checks,
  evidence hashes and successful cleanup. Missing, skipped, cancelled or failed
  jobs and missing receipts fail. No continue-on-error or branch/path exceptions.

Known boundaries and dependencies:

The candidate starts from main, not a combination of incident draft branches.
If the candidate still has a qualifier defect, the job must fail and retain
its stage. Absence of the incident-specific opening consumer is recorded as
not applicable and never substituted from another branch. Draft fixes are never silently fetched over it.
The first run may expose harness problems; a red result is not automatically
proof of a product problem. Reports must distinguish these cases.

The fixed image 310 is the initial old-data baseline only, never the candidate.
Its actual source SHA is read from the historical image revision label, never
from HEAD^1 of a PR. It must be reviewed and advanced deliberately as deployment
support changes. This is a new fictional seed retained across the test update,
not a production dataset or a reproduction of its complete migration history.
Normal delivery uses an explicitly synthetic format1 queue. Production-style
resume-required formats2/3 and pause are refusal scenarios only. The candidate
currently does not support format3; refusal is recorded, not called a successful
production-state replay.
Synthetic Bao runs with the real durable server configuration. Cold backup
readback of Dolt, PG, Bao and recovery bundle is checked. Semantic restore
rehearsal on a fresh stack is NOT yet covered. Browser screenshots must be inspected as pixels before readiness. Neither limitation is
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

The fixture uses an ordinary Docker bridge so the helper can prove its own
REJECT counters on routed negative probes. A separate DOCKER-USER host rule
blocks forwarding from that bridge to other networks, while allowing its
synthetic companions. The host rule is removed during cleanup. Host-bound
published-port TLS must pass in the actual runner, not be assumed.
Queue and backup contents remain private; their hashes in privateEvidenceHashes
are audit fingerprints, not independently downloaded evidence verification.
The aggregate rehashes the uploaded execution summary and script inventory and
requires receipt/summary fields to match. This is an anti-omission contract,
not protection against a malicious PR rewriting both tests and tested code.
Review and protected checks are still required.
