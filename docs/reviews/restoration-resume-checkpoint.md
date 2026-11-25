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
