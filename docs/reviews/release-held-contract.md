# Held-to-normal release, review draft

Status: NOT EXECUTABLE ON A REAL HOST. Host.preflight retains an unconditional refusal. Local unit tests do not qualify the host or a restored production dataset.

## Exact starting contract

Release is same-image only. Before release, the durable format3 history tip and recovery fence must match both the live SHA and immutable digest, with ui-open-automation-held and automation_held=true. Pause remains present, HOLD remains 1, no pending/failed/opening intent. The recovered host currently does not meet this contract: its historical delivered tip differs from its live restored image. Release must refuse this mismatch, never rewrite history or silently adopt the current image.

A separate reviewed recovery/adoption must establish source ancestry, actual image digest, migration ledger, preservation, gates and observed runtime, and append an audit for the restored target while retaining the original incident, pause and HOLD. Existing adoption entry points do not cover an already resolved format3 held state with a different live image. No such new adoption implementation is included here yet. A fabricated pending/failed pair is not acceptable.

## Isolation contract required before enabling preflight

An isolated rehearsal must use a coherent stopped copy of all three stores, a distinct Docker network with no external egress, no published app port, no host-network mode, no Docker socket, no production bind mounts, no production credentials and no production endpoints. Only fixture credentials and fixture upstreams are allowed. The copy's original encrypted credentials must not become usable by importing the production decryption key. Mount/image/network inspection plus negative egress probes and upstream request counters must prove these claims before the first normal boot. Declared booleans or a receipt with complete=true do not prove isolation.

The rehearsal must execute the exact release controller and image, record hashes of controller bytes, all input copies, env before/after, policies and runtime profile, and show the expected synthetic effects and refusal cases. It must verify that source production stores are unchanged. This executor and independent evidence verifier remain UNIMPLEMENTED. Host.preflight therefore remains closed. It is not sufficient to supply a hand-authored isolated_qualification JSON.

## Backlog evidence

release-backlog.mjs is a read-only producer intended for execution inside the held app, using its live SQL server. It enumerates every database/branch and binds working roots before and after, hashes all rows in relevant workflow runtime/configuration/cursor tables, and exports counts and hashes only. Missing runtime table, moving roots or query errors refuse. It does not claim that upstream events are absent, nor that the current capture alone authorizes replay. Tests use a fake SQL connection; actual Dolt execution is still required.

Capture must occur again after public gates are closed, with new webhooks prevented and hold still active. Compare exact branch/table evidence with the reviewed inventory; any delta requires review. Local row content must be reviewed privately for recipient/provider/action scope, retained locks, inbox items and external event catch-up. Hashes alone cannot prove that scope. Both internal inventory and external upstream reconciliation are required before effects.

## Commit and failure contract

Install and verify the format4-aware boot guard and all readers/controllers before any format4 writer or HOLD removal. Disable/mask boot supervision and exclude competing mutators during bootstrap. Acquire journal and actual updater locks. Keep a durable release intent, including subprocess identity and inherited lock, before each action. Close both public access gates and prove 503. Stop the held app and capture preservation evidence. Atomically install the reviewed normal environment and policy, preserving all unrelated bytes.

The durable normal-start-committed marker precedes the first non-HOLD boot. This boot can resume workflows and cause external effects even while the public front returns 503. Health is not the effects commit. No automatic retry, restore, old-image boot or rollback after this marker. An interruption may only rearm access once the exact queue and child are proven absent. Unknown identity remains report-only. A committed release can remove only its own exact pause bytes; separate finalization does not restart or replay.

## Paths and future CI

Every effective path must be explicit and consistent: env, ordered queue, state, pause, updater lock, boot script, qualification policy/postcheck, data, backups and both access gates. Active restored trees must not fall through to /opt/lyam defaults. Future qualification must use the committed normal policy requireAutomationHold=false. The prior policy must be retained and hash-bound. The operational policy path is explicitly bound through LYAM_QUALIFICATION_POLICY; update.sh forwards it to both qualification phases. The planner release-paths.py returns required bindings without writing any file. It is preparation, not verification of the host.

CI credentials/known-hosts/forced-command and environment selection must target the E5 deployment root. The forced command must accept only intended status/drain operations using those exact paths. Never weaken its allow-list or set format1 to bypass pause. After the audited release, qualify and observe the first real ordered update and receipt before declaring CI restored.

## Local tests and limits

Executed after rebasing WIP onto main276d32: release-held14, release-host5, release-bootstrap3 and release-supervision16 Python tests pass; four backlog producer Node tests pass. Host/controller, Docker/systemd and SQL calls are doubles except real subprocess/lock/OS identity tests. No Docker is available in this development environment. No isolated-copy rehearsal, host release, live SQL producer run or deployment has been performed. This draft is for incremental review, not a merge or deployment recommendation.
