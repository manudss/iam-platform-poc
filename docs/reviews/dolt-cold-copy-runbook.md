# Cold Dolt copy only, review gate

Status: NOT approved for E5 execution. No held query, no service start, no migration,
no effect admission, no network change. The operator executes only after main
confirms the reviewed immutable controller hashes, plan hash and new paths.

## Known source, operator observation November25 22:37 Paris

`/mnt/lyam-source/opt/lyam/data/dolt`:15069538 regular-file bytes,
32 regular files,22 directories, no symlinks/special/hardlinked files.
UID/GID0 throughout. Directories0755; files9x0777,6x0600,16x0644,1x0660.
Never normalize this source. It is the read-only clone mounted from `/dev/sdb1`.
Clean shutdown is NOT proven (Exit137); this copy does not repair that evidence.
Cold SQL refs/tables/objects remain unknown. Candidate recovery-before8refs are
not an independent inventory of this cold source.

## Phase1, plan only

1. Install reviewed source-stage/controller files root-owned under an isolated
   root700 directory. Verify exact published SHA256 before invoking any Python.
2. Re-read `findmnt` and `blockdev --getro` for source disk and partition. Mount
   must remain ro,nosuid,nodev,noexec,norecovery, device identity unchanged.
3. Run source-stage `--controller-sha256 <reviewed hash>` and
   `--plan-out /root/dolt-source-plan-<new16hex>.json`.
   This reads source twice, rejects links/specials/hardlinks/changed files and
   writes a private0600 plan with content hashes, metadata and mount identity.
4. Return plan SHA256 plus summary and mount/block-readonly evidence to main.
   No incoming directory exists yet. Check totals against the source observation.
   A difference is a refusal to investigate, never an automatic new baseline.

## Phase2, exact approved staging only

Use that SAME protected plan with `--plan`, `--plan-sha256`,
`--stage-root /root/dolt-evidence-<new16hex>` and
`--execute-reviewed-stage`, plus reviewed controller hash. Root must be absent.

Controller re-hashes the immutable source before copying. Python copytree uses
symlinks=True, copy2, never hardlinks or dereferencing; inventory rejects any link.
After copy, rehash source and incoming, compare paths/types/sizes/bytes, and write
private stage.json. A read error or mismatch refuses, keeps partial staging
private, never retries or cleans source. Source is never mounted into a container.

Call reviewed prepare_work_copy(incoming,work) from the hash-bound copy controller
in the same protected directory. It creates absent sibling work only, inventories
metadata/content before/after, normalizes new work only to root700/600, compares
bytes and checks incoming unchanged. Keep stage.json/preparation.json private.
Do not treat successful staging as a successful Dolt read.

## Phase3, disposable offline read only

Stage protected exact copies of dolt-copy-capture.py and qualification-container.mjs
in a sibling code700 directory. Bind their reviewed hashes, including the entire
executed_source wrapper hash, in a private fresh spec. Work/output paths and image
ID must come from actual phase2 and docker image inspect, never guessed.
Use local image81aeb exact digest; no pull/network repair is authorized here.

Existing copy CLI executes only work mounted readonly in netnone, rootfsreadonly,
1GiB tmpfs,1.5GiB memory/no swap,0.5CPU,PID96,OOM1000. It copies to private tmpfs
before Dolt access. At least3GiB host MemAvailable plus disk headroom is required.
Timeout/refusal must preserve attempt.json, work and source. Named container must
be removed and cleanup confirmed; never remove other containers. No app boot.

Report exact source plan/stage/preparation/capture/attempt hashes and real measured
bytes/files/ref counts. A non-null host memory sample, OOMfalse, exit0 and verified
cleanup are required for this milestone. A green read can provide cold tables-v3
for comparison; it cannot prove pre-shutdown application consistency, historical
bus cursors/payloads, source version history, or restoration admission.

## Current unresolved gate

The richer8ref fixture currently refuses offline branch capture. Do not run the
production copy CLI until that cause is understood and exact updated reader has
passed a real runner. This is independent of approving phase1 read-only planning.
Held read remains a separate, fenced task requiring concrete runtime bindings,
locks, cgroup load thresholds, server stability and independent review.
