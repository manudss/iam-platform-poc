# Ordered Oracle automatic deployment, activation remains gated

This replaces the old image-workflow completion trigger. It does **not** activate the host,
install the queue, adopt a dataset, remove UPDATE_PAUSED or authorize a merge.

## Why a durable cursor

GitHub concurrency is not a FIFO. It keeps at most one pending run and can replace it.
The old main image concurrency also cancelled a build when another push arrived. The new
OCI workflow has no concurrency group. The host serializes plans with a persistent file
lock and journals each successful SHA/digest. No secret GitHub token is stored on the host.

Every workflow run reads the last confirmed host SHA, fetches main, and enumerates **every
missing first-parent commit in order**. A multi-commit push yields several queue entries,
not just its head. A merge is the commit on main; this does not separately deploy historical
commits from the merged side branch that were never main heads. History rewrites/divergence
refuse, never reset the cursor. More than 32 pending entries refuses and needs deliberate
batching (GitHub job limits), never silently truncates. All pending entries are qualified
before this batch deploys; any red CI prevents batch delivery and is visible in Actions.

Each SHA runs the full reusable CI on that exact checkout, followed by an image build from
that exact SHA. The immutable image digest is passed through a per-SHA artifact receipt
in the **same run**. Host delivery uses that digest, not latest or a mutable branch tag.
Independent main CI still runs. Image concurrency is now per-run/SHA instead of cancelling
an earlier main build. PR checks may still cancel superseded PR versions.

The host validates contiguous parent links, full SHA/digests and known baseline. It skips
only the identical already-confirmed prefix (same confirmed source SHA, preserving its original deployed digest). A later workflow arriving
first still contains all earlier missing commits and deploys them first. An older workflow
arriving later is an already-confirmed no-op, not a rewind. An overlapping workflow may build the same source SHA with a different digest because
image signing keys are generated at build time. That already-deployed prefix is skipped
by confirmed source SHA; the original historical deployed digest is NEVER overwritten,
substituted or redeployed. Only still-missing SHAs use their same-run qualified digest.

## Failures and interruption

Before invoking the preinstalled qualified updater, the queue atomically fsyncs a pending
entry. A nonzero updater result records failure and blocks **all following commits**. Even
a successful rollback does not pretend that the failed commit was deployed. A crash after
an update but before the cursor write is uncertain: the pending entry blocks automatic retry.
Do not delete it blindly. An operator must verify actual image/digest, migrated ledger,
backup/restored data and the maintenance barrier before a reviewed journal repair. The tool
deliberately has no automatic skip/reset/retry command. A user decision is needed if a broken
main commit must be repaired or skipped rather than deployed as requested.

GitHub runner cancellation, network loss and finite runner lifetime are possible. The durable
state preserves the outcome or pending uncertainty; it cannot guarantee immediate delivery.
An Actions failure remains visible. After resolution, workflow_dispatch recovers ALL remaining
main commits from the host cursor. Do not interpret a green image build as a deployment.

## Pre-opening gate

Automatic queue calls update.sh with `--require-qualification`. It refuses **before any stop**
if LYAM_POST_UPDATE_CHECK is absent or not executable. Every gate lift, including rollback
or a preserved-old-image restart, invokes this checker while the marker is still armed.
A nonzero/unknown result leaves the marker armed. An after-check failure does NOT
trigger automatic compensation: the candidate stays behind maintenance for explicit review.
Only a create/health failure enters automatic image+data+PG+Bao compensation. Its restored
previous image must pass the checker too before any gate lift. A failed compensation checker
keeps503 even when that image is healthy. No lift/check/reactive-rearm window exists.

The root-owned checker is a separate, site-specific qualification component. It must be
implemented and proved on a complete isolated copy before activation. The queue integration
alone is **not** that qualification. It must check the actual expected immutable image and
stability, migration ledger complete/no pending, strict authenticated activation journal
schema (a verified empty journal can be valid), expected independent origin list/negative
redirect, real OIDC/session behavior, covered secret metadata, data preservation invariants
and public host/TLS maintenance paths. Missing inputs, 401/403, partial coverage and malformed
responses are UNKNOWN and block. Never derive the permitted origin set only from the new
image's own environment.

Migration-specific expected transformations must distinguish intended changes from loss.
Blind whole-PG equality is wrong when boot/login append audit rows. Blindly ignoring changed
tables is also wrong. Verify prior journal rows remain, sequences stay monotonic, unchanged
branch roots/credentials remain, and each declared migration has its own postcondition and
preservation checks. Bao LIST needs real permission and complete policy-selected namespace
coverage, not a fixed guess of two paths. No secret values belong in reports or Actions logs.
OIDC smoke tests create normal session/audit records, not business edits.

The configured checker receives only paths/nonsecret routing via argv: --container, --image
(actual image), --target-image (requested candidate, different on rollback), --env-file,
--data-dir, --backup-dir and --barrier-file. It reads private inputs itself, does not print
them, never removes the gate and exits nonzero on uncertainty. It must use the expected-image
context correctly for rollback. The root updater/checker/queue are installed after review,
not overwritten from an unqualified default-branch checkout by every workflow.

## Coordinated first activation

1. Keep UPDATE_PAUSED and independent operations barrier under operator control.
2. Qualify the migration image, complete backups/restoration, explicit existing-data adoption
   and mandatory pre-opening checker on a complete isolated copy. No implicit reseed.
3. Install root-owned update.sh, checker and ordered-queue.py under /opt/lyam/bin. Record their
   qualified checksums and add them plus queue state/policy to LYAM_STACK_FILES/recovery bundle.
4. Create /opt/lyam/deploy-queue root-owned mode0700. After the approved first image is proven,
   initialize exactly once with its verified commit SHA and actual image digest:
   `sudo python3 /opt/lyam/bin/ordered-queue.py initialize-reviewed --sha <full-sha> --digest sha256:<digest>`.
   Initialization never overwrites an existing journal. Do not guess a baseline from a tag.
   This SHA MUST be on the actual current main first-parent chain. A historical candidate
   image built from a PR-side commit is not a valid automation cursor, even if its image
   digest is known. First coordinate deployment/adoption and qualification of an approved
   actual-main image, then initialize that proven pair. Never invent a parent link or
   relabel an off-main deployed candidate as a main commit to make the planner proceed.
5. Configure OCI_DEPLOY_SSH_HOST, OCI_DEPLOY_SSH_USER, OCI_DEPLOY_SSH_KEY and NEW
   OCI_DEPLOY_KNOWN_HOSTS (a separately verified pinned host-key line). The workflow uses
   StrictHostKeyChecking=yes; ssh-keyscan alone is not authentication. No key values in chat.
6. Restrict dedicated SSH/sudo access to the installed queue and its status/drain operations.
   No arbitrary sudo script copied from Actions. Prepare the qualified hook path in lyam.env.
7. Only after those proofs, remove the deliberate pause in the coordinated operation and
   dispatch the workflow. Verify each expected SHA/digest in the durable history, not just
   the workflow's green status. Emmanuel keeps PR merge control.

Local tests cover multi-commit planning, out-of-order overlapping runs, duplicate prevention,
rebuilt-overlap digest preservation, gaps/divergence, apply failure and crash-pending refusal, plus mandatory hook
failure before stop and gate-held success/failure. Full isolated host qualification and real
workflow_call validation remain activation requirements, not claims made by unit tests.

## Versioned qualification controller

`deploy/oci/qualification.py` with adjacent `qualification-container.mjs` implements the
checker, not merely the hook protocol. Install both together. The updater calls `--phase
before` after stopping the app and before backup, then `--phase after` while the gate remains
armed. A private unique evidence directory retains hash-only pre/post snapshots and smoke
results. The controller requires an independent root-owned policy at
`/opt/lyam/qualification.json`; `qualification.policy.example.json` is a **template**, not
an approved production policy. A wrapper may add `--policy <copy-policy>` during isolation tests.

It checks TLS-valid 503 on every expected origin, actual immutable image and stable restart
count for30s, complete migration ledger checksums, real OIDC/password login with PKCE/state
and session verification for each expected redirect origin plus a negative redirect, and
strict authenticated activation journal schema. It captures every Dolt database/branch HEAD
and dirty working root, explicitly selected persistent credential files, PostgreSQL row-hash
multiplicities/schema/index/constraint/view/function/sequence definitions and monotonic
sequence state, plus complete recursive Bao KV-v2 metadata hashes under the policy roots.
`secret/metadata/iam` covers both current and not-yet-existing plugin/workflow namespaces
through their parent, including entries absent from the plugin registry. A denied LIST or
unknown response blocks. The Bao app token is currently insufficient; the controller takes
a separately approved metadata-only qualification token through a private local file.
Copy-only permission must NOT be silently applied to production. No values are printed.

PG rows are exact by default. Only independently reviewed append-only tables permit additions,
and every old row including multiplicity must remain. The current known PG tables are
public.activations and public.decision_audit; Dolt session/MCP tables are not PG tables.
For any other drift, the controller refuses unless a root-owned **exact image-ref-specific**
transformation verifier has been reviewed, tested and listed in the independent policy.
Such a verifier receives the private hash-only before/after files and must prove the whole
transformation including preservation outside it. There are no broad ignore-table settings.
The smoke login runs before the final capture, so its permitted audit additions are included
and credential/business changes cannot slip through by happening after comparison.

The controller is still subject to real isolated-stack qualification. In particular, prove
read-only offline Dolt inventory in the helper image, real PG17 SQL, metadata-only Bao
permissions/coverage, the actual hosted form fields, and TLS front checks. Missing inputs
or implementation failures leave maintenance armed and are blockers, never success claims.

### Digest-specific transformation verifiers

A verifier such as `deploy/oci/verify-0002-account-blocks.py` is root-owned, installed next to
`qualification.py` (same directory; it imports the controller's comparison), executable, and listed
in the independent policy under `transformationVerifiers` keyed by the **exact** `--image` string the
updater passes, including the repository prefix (`ghcr.io/manudss/iam-platform-poc@sha256:...`), not
a bare or shortened digest. The controller invokes it as `verifier <before.json> <after.json>` with
the private hash-only evidence, which is only read, never modified. It must prove every declared
transformation of that exact transition and preservation of everything else, exit 0 only on complete
proof, and treat anything unknown as failure. Hash-only evidence alone cannot prove commit content,
so the verifier additionally performs read-only live checks with a two-class guarantee. On the one
TRANSFORMED branch (iam/main): the captured AFTER root must equal the database hash of its own branch
commit via DOLT_HASHOF_DB('<branch>') with DOLT_HASHOF_DB('WORKING') proving a clean working set, and
the captured BEFORE root must equal DOLT_HASHOF_DB('HEAD') inside the host-proven revision database
'<database>/<before-commit>' - a dirty working set at either capture time is UNKNOWN, not silently
accepted (raw commit hashes are rejected as DOLT_HASHOF_DB refspecs by the deployed Dolt 2.6.1; on
database iam, branch refs, WORKING, HEAD and the revision database are host-proven coherent). On every
UNCHANGED branch the guarantee is PRESERVATION, not commit/root binding: the live session identity
(DATABASE()), the branch head (dolt_branches, the capture's own read path) and DOLT_HASHOF_DB('WORKING')
must equal the capture exactly, before and after and at the fresh recapture; any head or root drift is
refused, while a pre-existing dirty working set preserved identically is accepted - cleanliness is only
required where a commit is claimed to explain the state. Named refs and revision databases are NOT used
on unchanged branches: on this host they returned another database's root for iam_meta while DATABASE()
kept echoing the requested name (fixtures 2026-11-21; mechanism unproven, not attributed to a defect).
No ref is ever created.
CI enforces the supply side: a PR that adds a version to data/migrations/manifest.json must ship deploy/oci/verify-<id>-*.py, its counter-test suite and the ci.yml step running it (deploy/oci/migration-verifier-guard.py). This is a structural aid only: it checks that the pieces exist (and runs the counter-test suite separately), it does not prove that the verifier is valid, that the ci.yml step really runs in CI, or that the host policy matches. It does not remove the possibility of a fail-closed host stop at deploy time, and it is not a qualified nominal path.
On the host side, BETWEEN cycles only, the operator installs the reviewed verifier root 0700, adds the exact target image key to the live policy's transformationVerifiers, and proves it with the read-only deploy/oci/update-preflight.py (--image <exact ref> --verifier-sha256 <reviewed pin>) BEFORE update.sh starts its before-phase - the policy hash is captured into before.json, so a mid-cycle policy change fails closed by design. The preflight is an operator checklist tool, NOT a lock wired into update.sh or the queue; its ci.yml presence check in the guard is a text heuristic (the suite is executed separately by the guard), and the preflight checks structure only (exact key, root ownership, 0700, pin). The independent review remains the semantic gate, and each new data transition needs its OWN verifier wired to its OWN image pair.
The migration commit chain/content is read from live Dolt with every diff flag present
and explicitly valued (absent or NULL flags are UNKNOWN), and a COMPLETE fresh recapture through the
controller's own immutable capture machinery (Dolt+Bao container script, controller PostgreSQL
surfaces, credential files, migration ledger) must equal the historical after-capture exactly - a
database, branch, table, secret or ledger entry created after the capture is detected.

The policy file is hashed into each `before.json`: **changing the policy between the before and after
phases of one update fails closed** (`qualification policy changed mid-update`). A verifier entry can
therefore never be added to rescue an already-failed after-phase. And while the failed run's
maintenance marker still stands, the updater refuses to start over a gate it does not own, so a plain
re-run is not available either. The reviewed recovery for this situation is an EXPLICIT exceptional
operation, never a silent bypass:

1. Review and install the verifier; do not touch the policy.
2. `recover-0002-proof.py` (no business-data mutation; its audited OIDC logins create ordinary
   session/audit events and it creates its report files): full verifier pass on the preserved
   evidence pair, the controller's immutable smoke re-run on the gated candidate (real OIDC login
   per origin, negative redirect, journal, ledger), gate still 503 on every origin, exact marker
   ownership token with a dead owner process, both runner locks free, queue state exactly the
   reviewed failed entry. Runner hashes cover the queue runner at its REAL installed path
   (`/usr/local/libexec/lyam-queue/ordered-queue.py`), never a copy; the effective environment
   configuration is frozen into the report. One private hash-only PASS report; any failure means
   no lift and no journal change.
3. Only after the coordinated owner approval, `recover-0002-close.py --approval-ref <reference>`
   (the reference RECORDS the external approval; it is a trace field, not a permission check):
   requires a fresh PASS proof (stale or future-dated reports are refused), frozen
   runner/policy/evidence/queue/env hashes, re-checks every precondition live (including exactly
   one container of the verified image, running and stable for at least 30s), runs the COMPLETE
   verifier recapture again under both locks immediately before any lift, archives the queue state
   (pending+failed), the proof AND both evidence files into a private incident bundle, then lifts
   the marker, proves 200 on every origin, re-runs the real OIDC smoke and a complete post-smoke
   recapture - strict on every surface (schema, sequence DEFINITIONS, Dolt, Bao, credentials,
   ledger) except declared append-only PostgreSQL table rows and sequence CURRENT VALUES; row
   comparison walks the union of hashes with every multiplicity preserved, so a vanished row is
   always caught; sequences are monotonic counters: advancement is allowed, any rewind
   (last_value down, is_called True->False) or unknown type/shape is refused; the activation
   journal must stay exactly as captured; only declared audit tables may grow, counted and
   traced. Only then the reviewed entry is
   appended to the queue history (same SHA/parent/digest, existing entries untouched) in one atomic
   fsynced write, with a separate incident trace linking failure, proofs and approval.

Failure semantics of the closure (faithful exit codes, no silent claims):
  - 1: aborted before any lift - gate untouched, no journal change;
  - 2: failure after lift, gate re-armed with the archived token AND 503 re-confirmed on every
    origin - no journal change;
  - 3: failure after lift, re-arm attempted but 503 NOT re-confirmed - gate state unknown, the
    operator must verify the origins immediately; OR the queue file could not be re-read after a
    failed journal append - journal state UNKNOWN (never claimed unadvanced), operator reconciles;
  - 4: the incident trace failed AFTER the journal append - partial commit: the journal advanced
    and the verified front stays open (re-arming would contradict the journal); the operator
    completes the trace from the private archive.
SIGTERM/SIGINT during the lifted window take the same re-arm path, and ANY interruption of the
journal append (error, timeout or signal) resolves the journal state by INTEGRALLY comparing the
queue file with the expected repaired state and the original: advanced, unchanged or UNKNOWN -
never claimed from local sequencing. No in-process mechanism can survive SIGKILL, a power loss or
an OOM kill between lift and re-arm: those are documented residual limits requiring operator
reconciliation (check every origin for 503, re-arm manually with the archived token, reconcile the
journal against the private incident archive), not a promise of perfect protection.

Do not modify the policy mid-cycle, do not delete the preserved evidence, and do not lift the gate on
the strength of anything but this reviewed sequence.

### Existing HTTP-loopback copies

For existing isolated copies whose preserved issuer/redirect origins are HTTP loopback,
`--isolated-loopback-test` plus policy `isolatedLoopbackTest:true` permits HTTP **only** on
127.0.0.1, localhost or ::1. Both are required. It still requires503 at the dedicated copy
front and all data/auth checks. The normal updater never supplies this flag. Public HTTP
hosts remain refused even in test mode. Evidence and the result explicitly say
ISOLATED_LOOPBACK_NO_PUBLIC_TLS_PROOF. This tests preservation/auth on the copy, **not** TLS
or the three production hostnames. Do not change preserved copy origins just to make a test
pass, and do not arm the production front. A separate real-TLS disposable-front test and
coordinated final production-origin checks remain required before production activation.

### Host-free workflow-call qualification

Manual dispatch defaults to qualification_only=true and requires a full sha input. It
runs the real reusable CI/image workflows and validates their same-run digest receipts.
SSH preparation and delivery are skipped. This proves workflow composition, exact SHA
and artifacts, not the main first-parent recovery or a deployment. A normal push is not
qualification-only. An intentional manual production recovery must set qualification_only
false explicitly, after the operational gates above are satisfied.
