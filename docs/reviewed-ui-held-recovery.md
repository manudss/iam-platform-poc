# Reviewed UI-held recovery after a fence, DRAFT

Purpose: make the existing held application reachable, without declaring workflow automation restored. No merge, installation, host execution or pause removal is authorized by this change.

## Preserved baseline

The queue baseline is the supplied host superset aca10ace85a81f3aa4d4faa470f7824290a68d0e85167821033638261f493910, not repository 59b1. Existing in-place, replacement-chain, receipt, source-chain, digest, audit and resume guards remain.

## Transition

`open-reviewed-ui-held` requires both queue and existing updater locks, deployment pause present, format 2/3 state, resume_required true, no pending/failed/opening intent, recovery_fence exactly the last cursor. The manifest binds its complete state fingerprint, prior delivered SHA/digest, authorization and evidence references, one exact first-parent successor on origin/main, and target digest. References attest operator review; they do not authenticate permission.

A separately hash-bound installed controller validates root-protected ancestry, closed receipt and integrity/controller inventory, launch proof, helper live confinement, exact running image source/digest, held seed/restart/capabilities, persistent hold and API held report, native TLS 503 for every policy origin, reviewed held preservation policy and before/after/smoke hashes. It invokes a fresh after qualification against the original before baseline while both gates remain closed. The fresh evidence is separately named qualified-held-before-opening, never qualified public delivery.

The queue durably writes a format 3 opening intent, exact gate bytes, manifest and original fingerprint before either gate is removed. Old installed format-2 queue executables refuse format 3. Removing both reviewed gates requires a new live confinement/hold check and TLS 200 from each origin. Only after that proof does history append mode ui-open-automation-held, a new recovery audit and fence. resume_required remains true. Generic resume is forbidden for this mode. Automatic drain/deploy stay blocked.

Any caught error rearms access gates, preserves the original cursor, and retains a blocking failed intent. This is NOT rollback of writes visitors may have made. SIGKILL/power loss can leave an intent: `rearm-interrupted-opening` only rearms the recorded access gates and does not declare delivery or clear the intent. Host boot under IAM_AUTOMATION_HOLD refuses normal restart/recreation and attempts this access-only recovery. Held container FIFO and restart=no remain.

## Scope and image identity

The current qualified target remains main 07dbc9ba and digest 310f5b0e. New queue/controller code is host control code, not inside that image. Merging this branch later would create a new main image and its own CI/first-parent successor. It cannot silently adopt that later SHA under the current single-successor manifest. Review and an explicit operational choice must settle installation version and target identity before execution.

## Tests so far

29 inherited queue tests pass. Eight new isolated transaction tests pass: successful distinct partial outcome, failed opening rearm/no cursor advance/retry blocked, interruption, source and observed-image refusal, stale fingerprint/digest/chain/outcome/approval refusal, pending/failed/unresumed state refusal. Existing 11 host-boot tests plus a persistent-hold boot refusal test pass. Nineteen focused controller tests pass, with mocked external commands and temporary evidence. These are not a complete live controller qualification.

## Execution boundary and remaining evidence

Local isolated tests are complete for the stated guards, but this is not host qualification. Remaining evidence is real Docker/Caddy integration, rendered and authenticated UI verification, and SIGKILL of the actual controller. No installation or opening has been performed.

## Interruption and proof limits

SIGKILL or power loss after unlink can leave access partially or fully open with a durable unjournaled intent until operator recovery. There is no instant crash rollback. The operator must supervise the opening and immediately rearm on missing final receipt, then verify TLS 503. Boot attempts access-only rearming and refuses application start/recreation under persistent hold. The SIGKILL test actually kills a fork between gate removals and confirms one gate absent, the other present, original cursor and intent intact, followed by access rearm. It uses a controller double to choose the crash point, not a live Caddy/Docker stack.

The fresh qualifier has a 180-second subprocess deadline. Exceeding it keeps both gates closed. After opening, proof covers public TLS 200, held API, confinement and identity only. It does not assert unchanged application data after visitors gain access.

## Final reviewed delta

The controller now has positive verify binding tests and positive opening-order tests, with refusal tests for exact config-integrity binding, helper mutation, config image, qualifier/container/policy outside the reviewed inventory, API hold failure, gate hashes, false receipt, evidence bytes, redirects, and all three origins. The opening-order test uses real gate files and real unlink, but doubles Docker/TLS/qualifier commands. It proves order, not a live Caddy deployment.

Gate mode, uid and gid are saved in the intent and restored exactly, including under restrictive umask. Re-arming also verifies public TLS 503 for every policy origin. If re-arming cannot be established, the failure remains access-unknown and attempts to stop the candidate. This does not undo writes.

The integrity output contains config_sha256, checked against the closed receipt, and verifies helper/controller/qualification inventories before those components execute. Opening controller bytes are separately hash-bound in the reviewed manifest and protected ancestry. Installation must record the reviewed PR commit, queue and controller hashes alongside the target 07dbc image digest. The read/hash then execute sequence retains a small root-only TOCTOU window. Do not modify installed root files during the engagement.

A failed or interrupted opening is intentionally one-shot. The retained intent blocks every new opening attempt. There is no reset, implicit retry or generic resume command. Retrying would require a separately reviewed state recovery change, not hand-editing or deleting the intent.

A post-opening /login TLS 200 HTML document with the expected Lyam title and app-root is checked in addition to /healthz 200. This is an HTML delivery proof, not a rendered or authenticated usability proof. The operator must perform the separately authorized sign-in smoke and visual desktop/mobile inspection before reporting usable UI. Both gates must cover every route, including /healthz and /login, in the active Caddy configuration; source documentation alone is not proof of current host routing. Active host gate configuration was inspected by the operator at 11:24 CET as recorded below; it must be revalidated at engagement.

Fresh before-opening preservation evidence is retained in the queue audit with its exact hashes and paths, distinct from the public-opening proof. No after-opening preservation comparison is claimed. A later code merge is separate from installing this reviewed host control code for image 170.

## Host routing evidence, 24 November 2026 11:24 CET

The operator's active Caddy admin inspection reports JSON SHA256 86ad3d6e2cbacac23ab134af0109167099fce6b941a73ac79f6a35370cf6e9a5. Each of three host routes applies headers, then a file matcher for either MAINTENANCE or OPS-MAINTENANCE returning 503, then reverse_proxy to 127.0.0.1:8080. No path exception or health 200 shortcut was found. Six TLS checks, root and healthz per origin, returned 503. This is read-only operator evidence, not our own host execution. Revalidate active route identity and closed status at engagement; do not treat this timestamp as permanent live state.

The exact HTML title and app-root check is intentionally fail-closed. A changed title or root tag will rearm access and burn this one-shot attempt. Before engagement, inspect the expected image UI artifact and live hold/identity/Caddy read-only evidence. A failed attempt is not retried automatically.
