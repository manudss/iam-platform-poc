# Restoration checkpoint, 2026-11-25 22:03 Europe/Paris

No complete normal release, automatic main deployment or reboot recovery is qualified. No merge or Oracle operation was performed by the code worker. Do not remove the unconditional release preflight refusal. Operator owns all host actions and the credit-protection shutdown.

## Retained qualified subset

- PR186 branch fix/release-held-normal. Host fixture files are frozen at e22a06b8; later commits change epoch/test work, not the three fixture files.
- Real disposable runner run https://github.com/manudss/iam-platform-poc/actions/runs/45699636029 succeeded. Downloaded artifact15061579681: both normal and host pre-FIFO succeeded, app never started, cleanup failures0, no containers/networks/tempdirs remained. All four host observations unchanged. This is no real store/app/release/boot proof.
- Final spec output is /root/normal-host-proof-0b6a92f418dce735.json. Exact held ID must still be freshly validated by the operator. Operator host execution/result is not recorded in this checkpoint.
- Epoch orchestration is prepared but has never run on E5. It never admits restoration or changes journal/HOLD/gates/pause. Same-epoch smoke mutates sessions/audit; refusal cannot undo it. Read-only runtime-check and real bindings/front443 remain prerequisites.

## Migration evidence, next useful read

Existing diagnostic inputs are eight Dolt refs containing database/branch/head/root only. They show exactly one metadata working root change, not its table-level content. The fixed verifier qualification-dolt-piece-storage-verifier.py already exists and its21tests pass. It requires complete dolt-tables-v3 evidence before/after. It permits only an empty workflow_piece_state table on iam_meta/main, with exact schema/DDL/status and unchanged existing tables/all other refs.

Find the preserved pre-migration source copy or a full earlier table-level snapshot. If it exists, capture it read-only with the same bound source and compare against current held. Never run migration again to manufacture a before. New capture on the held alone cannot prove the old table contents. The manifest migration0003 checksum in the repository is74ba7edb45a3364056485939f92e7d50145b2c6bea65de2d87c9bee97d6e1257, not yet an assertion about installed/image bytes.

## Bus evidence, next useful read

Known original files are nats-before-rotation.json and nats-after-rotation.json in /opt/lyam-recovery. Three streams and26consumers were reported, pending/ack0. Before includes redelivered, after omits it. Events15 and KV15706 were stable; retained journal22615 to22643 is+28 without attribution. Counts are not payload/cursor preservation. Do not fill the missing field with zero, interpret ack as a sequence without source schema, or call a fresh snapshot historical proof.

Locate original raw capture code, retained JetStream stream/consumer metadata, snapshots/backups and message sequence bounds. Preserve distinctions between pending, ack-pending, ack floors, delivery floors and redelivery counters. Compare actual payload digests/cursors only when both sides exist. Match the28added journal messages to independent smoke/rotation records if retained, without exposing raw account/session data. If old coverage is gone, record the irreversible evidence gap and retain it in any later decision. Do not silently downgrade the promised preservation claim.

## Admission/release/boot remain separate

- No reviewed-restored-epoch append writer exists. Queue format5 validator still requires reviewed-restored-held, whose historical TLS receipt chain does not exist. Never relabel the epoch result or older isolated baseline.
- Release preflight intentionally refuses because real isolated coherent three-store rehearsal/verifier is absent. Real backlog collector and recapture code do not replace it.
- Normal controller has real Docker namespace proof; updater lifecycle has shell/double tests, not a full real app update. host-boot.sh deliberately refuses format4 before companion starts. Durable normal boot transaction is missing.
- CI dedicated user/key/sudo/secrets/knownhosts and exact active paths still need operator installation/verification. User merges, worker does not.
- release-host.observe_held currently rejects duplicate identical HOLD values; direct epoch checker accepts identical duplicates and refuses contradictions. Active env has no duplicates per operator. Do not recreate held merely to hide that discrepancy.

## Epoch evidence limitations

Attempt can exist before read-only preconditions, without any smoke. Post-smoke partial evidence is explicit complete=false/failed_components. After artifacts contain digests/counts only; baseline inputs remain private and potentially sensitive. Watchdog targets Node, not all Dolt descendants. Phase/recovery/final alarms are600/120/120seconds, not hard guarantees against SIGKILL or uninterruptible kernel I/O. No post-failure automatic retry or rollback.

## Operator update, 22:09 Europe/Paris

The preserved source filesystem /dev/sdb1 remains mounted at /mnt/lyam-source with ro,nosuid,nodev,noexec,norecovery. Both opt/lyam/data/dolt and opt/lyam/data/nats-js exist. A limited maxdepth4 search found no table-v3 snapshot, which does not establish absence elsewhere. No source service or migration was run.

Original bus capture code recovered from operator history fixes the semantics: messages=s.state.messages; pending=c.num_pending; ack=c.num_ack_pending, NOT an ack floor. Before alone included c.num_redelivered. Neither capture saved payloads, delivered, ack_floor, first_seq/last_seq or consumer configuration. Missing after redelivered is a real gap, not zero.

The e22 E5 test actually REFUSED normal namespace probes failed at launcher-real-docker, command94. App never started. Cleanup0, no owned resources remained, all four nonfixture observations unchanged, held exact ID remained Running/restart0. Its five positive probe booleans were not persisted in run.log or artifact. Thus cause cannot be isolated among PG/Bao TCP, public443 TCP and PG/Bao DNS aliases. Runner success does not transfer. No automatic replay, weakened test or speculative network fix. Existing host FORWARD DROP plus Docker chains and trailing reject is context, not proof of which probe failed.

## Minimal proposed migration evidence method, not execution approval

1. Operator verifies the source mount is still read-only and its exact device/path. Inventory and hash the Dolt source files with bounded capacity/time checks. Record read errors rather than omitting files. The original restoration refs/hash evidence anchors the source candidate; recomputing current file hashes alone does not authenticate an arbitrary replacement.
2. Copy the COMPLETE Dolt directory, including hidden .dolt data, manifests, working sets and untracked database metadata, to a fresh protected work directory on the destination filesystem. Do not use a hardlink clone, a symlink to source or an app data path. Reflink only if it is a real independent copy-on-write clone on a supported filesystem; ordinary copy is simpler. Check contents against the frozen source inventory before opening anything. Keep a second untouched copy for repeatability.
3. Verify exact Dolt binary/image version against the source deployment and the capture verifier assumptions (existing code calibrated for2.6.1). Use the existing already-local immutable image when verified. No pull, no app entrypoint, migrations, Bao/PG, auth or external credentials. A disposable network-none container may mount ONLY the writable work copy and reviewed capture code, with no Docker socket, host paths or published ports, no restart/caps, and resource/time/disk bounds. The source mount is never exposed to this container.
4. Use the existing dolt() capture logic's non-running local CLI path, factored into a narrowly reviewed dolt-only entry so it does NOT also call Bao. Local queries can create locks/metadata, which is why the work copy is writable. No SQL service is required. Capture complete tables-v3, all database branches/working roots/status/schemaObjects, and require refs match the recorded source refs. Any version/format incompatibility refuses; never migrate the copy to make comparison pass.
5. Capture the current held Dolt with the SAME hash-bound tables-v3 logic in running read-only mode under both actual updater/journal locks. Require stable identity and two stable inventories. No stop/start or migration. Compare raw before/after in memory or protected files using the existing exact verifier. Source SQL metadata may contain private text, so do not forward raw snapshots as non-secret artifacts. Report only verdict, exact scope and hashes.
6. A pass establishes only this migration's permitted Dolt change. It does not close PG/Bao/bus/session restoration, historical TLS absence or release admission. An inability to open the source copy safely is a blocker, never permission to start a service on the original.

## What the preserved bus source can establish

An independently copied complete cold nats-js tree may retain original stream payloads, sequence bounds, stream/consumer configuration and delivery/ack state. First bind exact NATS version/config/store_dir/account layout and preserve a byte-identical untouched copy. Do not parse unknown binary formats with guessed offsets. Only after a separate reviewed method, open a WORK copy using the matching NATS binary, with all networking isolated, no routes/leafnodes/gateway/upstream credentials and no app clients. A server may rewrite its work copy during recovery; that is not a new historical source. No NATS service is proposed on the mounted original.

Source recovered messages can establish the cold-side retained state, not what the restored server looked like at21:08. Compare to retained restored snapshots or current read-only APIs only with explicit observation times. Common sequence payload digests can prove the observed messages match; missing sequences/retention/compaction can prevent a complete comparison. Current counters cannot reconstruct omitted historical redelivery. A cold source relative to current state can narrow the28journal additions only if stream IDs, sequence ranges and independent event timestamps align; do not infer payload equality from message count. Persist digest/category summaries rather than session/audit contents. Without an after-at-rotation snapshot, that historical counter gap remains permanent and must be carried into any later acceptance decision.

## Method review conditions, 22:11

Before any future copy, verify block-device read-only state in addition to mount flags and record exact device identity. ro,norecovery does not prove filesystem consistency: an unclean ext4 source can omit journaled writes from the visible tree. Establish whether the cold capture was taken with the application stopped; do not replay the journal on the original to improve evidence. Matching recovery-before refs establishes an OPERATOR anchor, not independent provenance.

Inventory residual .dolt/sql-server.lock and recovery/journal files. Any lock removal can happen only on the work copy, separately logged and reviewed, never an automatic repair to make a test pass. Non-root container write permissions/chown apply only to the copy. Compare Dolt versions from source deployment image and candidate image;81aeb is not automatically the source version. No dolt migrate. CLI/server output discrepancies must refuse without normalization. Resource plan includes OOM score1000, caps/restart disabled, memory/PID/CPU/wall-clock/disk bounds, before/during MemAvailable and sufficient room for complete copies. Copy/snapshots are sensitive. Operator must own work-copy cleanup timing; untouched evidence and source are never deleted by this plan.

Prepared code now has an explicit dolt-only mode, using unchanged dolt() and no Bao or smoke call. running must be boolean; empty inventory refuses. running=false still copies /data/dolt into a temporary workspace through the existing function, so the caller must expose ONLY the already-created work copy, not the preserved source. Output is an envelope {format,kind,running,dolt}; verifier inputs must use its dolt array with normal qualification snapshot wrapping, never treat the envelope as an accepted before snapshot. This new source changes the capture hash and requires exact code review before any host run. Node dispatch tests use a mocked Dolt function, not real CLI/server evidence. Mode preparation is not a host execution grant or a full safe copy runner.

## Dolt-only code review closeout, 22:12

Current qualification-container.mjs SHA256 is3d5dd51d75568628698fd2716c824913e91ebb85d3d2652ee8b870ebd754cadd. All old capture bindings/specs are invalid until regenerated and reviewed. No real capture is validated. running=false makes an additional recursive copy into container /tmp; plan room for that full extra copy. A read-only rootfs requires a separately sized writable /tmp, with memory/disk bounds compatible with host capacity. Reject symlinks/hardlink escapes in the supplied work tree, and do not expose the preserved source as its mount. Caller still owns version checks, resource/time/disk limits, lock/identity proofs and stable inventories. The envelope-to-verifier snapshot adapter remains unimplemented. Dispatch tests prove only routing using a Dolt double. No further work or host execution is scheduled for this method tonight.
