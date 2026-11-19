# Persistent Lyam demo on a VM (OCI) - deploy and update runbook

The hosted free-tier demo (`docs/demo.md`) resets on every restart because Render's
filesystem is ephemeral. This page is the other hosting mode: a small VM with a durable
disk where the demo **keeps its data across restarts and updates**, new versions publish
automatically from `main`, and an update can never re-seed or wipe what is already there.

Everything here stays within the same fictional-data demo scope. No employer resource, no
real user data.

## Guarantees (and how they are enforced)

1. **No re-seed, ever.** Updates run the container with `IAM_DEMO_SEED_MODE=never`. The
   updater (`deploy/oci/update.sh`) refuses any image whose `io.lyam.seed-modes` OCI label
   does not list `never`, so an older image that would force seeding cannot be rolled onto
   the volume by mistake. In the image itself, a Dolt READ ERROR is never treated as an
   empty database (`demo/dolt-state.mjs`): any doubt stops the boot instead of seeding over
   existing data.
2. **Backup before every update.** The container is ALWAYS stopped first (cold, consistent
   files - even for a same-image redeploy), then: tar of the data directory, a per-database
   `pg_dump` of the PostgreSQL companion (a failed export aborts; no pipe can hide it) with a
   FULL application-state capture (per-table row count + an order-independent content
   hash of every row; a normalized, semantically stable schema export - columns with defaults,
   constraint DEFINITIONS (never synthetic catalog names, which embed internal identifiers
   that change on drop+recreate), name-stripped index definitions, views, functions,
   sequence definitions - hashed as a whole; and every
   sequence's last_value + is_called, every query under ON_ERROR_STOP so an enumeration or
   read failure aborts the capture, never ignored), a tar of the OpenBao storage plus its
   unseal-key
   directory taken while the Bao container is stopped (the keys are MANDATORY: the updater
   refuses a Bao backup without them), and a private recovery bundle (0600) with the env file,
   the compose / bao config / policy files and a manifest of the generation. A host lock
   (`LYAM_LOCK_FILE`) refuses concurrent runs.
3. **Front gate + health gate + compensation.** Before the container stops, the
   updater proves a FRONT GATE through the public origin: it drops its OWN maintenance
   marker (unique token; a dedicated front-readable directory, never under root-0700
   /opt/lyam) and refuses to continue until the origin answers 503 (Docker's
   loopback port publication is served by userland docker-proxy, so host netfilter rules
   never see front traffic - the gate must live at the real front, and `curl` through the
   origin is the only proof that counts). A gate this run did not create is never removed;
   a pre-existing foreign gate refuses the update. The gate is held for the whole update
   window and lifted only as remove + proven 200 through the origin once the new version -
   or the rolled-back previous one - is healthy; a failed lift RE-ARMS maintenance
   (exit 4, no blind rollback of possible new writes), and every other failure path keeps
   the gate up. Health is probed INSIDE the container, so the gate never
   hides a failure and no visitor write can reach a version the rollback would discard; the
   validated container is never recreated. Any failure rolls back image AND data together:
   the pre-update backup is restored first (the failed version may have migrated the Dolt
   schema or plugin state at boot, so an old image on a newer data state is not a safe
   rollback). The PostgreSQL restore verifies the dump (gzip integrity + dump header) BEFORE
   anything destructive, then drop + recreate + replay (`ON_ERROR_STOP=1`) and compares the
   FULL post-restore state against the pre-update capture (a postmortem dump of the failed
   state is kept first). The OpenBao storage is restored and unsealed before the previous
   image starts. If ANY verification fails, the service stays DOWN (exit 4) rather than
   exposing an unverified state.
4. **Immutable versions only.** The updater accepts a full commit-SHA tag or a
   `@sha256:` digest - never a moving tag like `latest`.
5. **Deliberate freeze.** Creating the pause file (default `/opt/lyam/UPDATE_PAUSED`)
   blocks every update, manual or automatic, until it is removed.
6. **Two backup layers, no confusion between them.** The updater's local backups
   (`LYAM_BACKUP_DIR`) exist for fast rollback/restore on the host. The durable,
   disaster-recovery layer is the platform volume SNAPSHOT, owned by the platform operator,
   triggered through `LYAM_PRE_UPDATE_HOOK` while the container is stopped (a failing hook
   aborts the update: the swap never happens with an incomplete preservation chain). A local
   backup dir is NOT automatically a remote snapshot, and a volume snapshot does NOT capture
   in-RAM state (the built-in RAM Bao is only covered after the switch to the persistent
   Bao). A volume-restore drill of the snapshot layer remains a platform-side task.

## Topology

One docker network (`lyam-net`) with:

- `lyam` - the all-in-one image (Dolt + core + API + console), data on the host volume
  `/opt/lyam/data` mounted at `/data`, port published on loopback only
  (`127.0.0.1:8080`), HTTPS terminated by Caddy on the host.
- `pg` (optional) - PostgreSQL with its own volume: durable activation journal and
  decision audit via `IAM_PG_URL`.
- `bao` (optional) - OpenBao with embedded PebbleDB storage (the legacy `file` backend was
  removed in OpenBao 2.7): durable plugin and workflow-connection
  secrets via `IAM_BAO_ADDR` + `IAM_BAO_TOKEN`.

Without `pg`/`bao` the demo still keeps its Dolt data and credentials across restarts,
but the activation journal stays in memory and Bao secrets are lost on restart. That
fallback mode is what the persistence requirement rules out for the real demo: configure
both companions.

## One-time bootstrap

```sh
sudo install -d -m 700 /opt/lyam/data /opt/lyam/backups
cp deploy/oci/lyam.env.example /opt/lyam/lyam.env   # then edit; chmod 600
docker network create lyam-net
# First and only seeded boot (creates the dataset):
docker run -d --name lyam --restart on-failure \
  -p 127.0.0.1:8080:8080 -v /opt/lyam/data:/data \
  --env-file /opt/lyam/lyam.env --network lyam-net \
  -e IAM_DEMO_SEED_MODE=auto \
  ghcr.io/manudss/iam-platform-poc:<full-commit-sha>
```

After this first boot the dataset exists and every later start/update uses
`IAM_DEMO_SEED_MODE=never`. The updater refuses to run against a host that was never
bootstrapped.

### Front gate (Caddy)

The updater protects visitors from discarded writes with a maintenance marker, not with
netfilter: Docker publishes loopback ports through userland docker-proxy, so host iptables
rules never see front traffic (proven on the VM: rule counter zero, writes pass). The
marker CANNOT live under /opt/lyam (root-0700: the Caddy identity cannot traverse it) -
it lives in a dedicated 0755 directory that holds ONLY the marker:

```caddy
# one-time, in the site block for the public origin
@maintenance file /var/lib/lyam-front-gate/MAINTENANCE
respond @maintenance 503
reverse_proxy 127.0.0.1:8080
```

The updater writes its OWN marker (unique token inside) at `LYAM_FRONT_BARRIER_FILE`
(default `/var/lib/lyam-front-gate/MAINTENANCE`), refuses to proceed until
`curl $IAM_PUBLIC_ORIGIN/healthz` answers 503, and lifts the gate only as remove +
proven 200 through the origin once the healthy version serves. Semantics that matter:

- a marker this run did NOT create is never removed; a pre-existing foreign marker refuses
  the update (someone else's maintenance is not ours to lift);
- a failed lift (removal or 200-probe) RE-ARMS maintenance and exits 4: no blind rollback
  of writes the new version may already hold, no exposed-but-unverified service;
- every failure path (aborted preservation, failed/partial rollback, interruption) KEEPS
  the gate up - fail closed;
- coverage limits: a request already routed when the gate appears completes (the container
  stop drains in-flight work before any data changes); WebSocket/upgraded connections and
  HTTP/2 stream reuse rely on Caddy's per-request routing plus the container stop;
- the concurrent check proves the transition with a synchronized burst (503 while gated,
  only 200/503 across it) and then a DISTINCT post-lift wave that must be all 200 - the
  transition wave alone may legitimately finish entirely under the gate.

Prove the gate end-to-end on a THROWAWAY Caddy (never the main one) before trusting the
first update. The check is EXPLICITLY SYNCHRONIZED (no sleep-based racing): a single
connection is driven 200 -> gate up -> 503 -> gate down -> 200 with each response fully
read before the next step, and the concurrent burst starts only after the gate is confirmed
up and lifts only after 6 results are recorded:

```sh
sudo IAM_PUBLIC_ORIGIN=https://<test-front> deploy/oci/front-barrier-check.sh
```

### Host boot ordering and reboot drill

`deploy/oci/host-boot.sh` (driven by `lyam-boot.service`) owns the start order after a host
reboot: the FRONT first (the unit orders after `caddy.service` and the script waits, bounded,
for any HTTP answer from the origin - curl's exit status and HTTP code are read separately,
never concatenated: a doubled `000000` would masquerade as a live front), then `pg` up,
`bao` up AND unsealed, then `lyam`. Before any `docker start` of the
app it compares the UNION of the `IAM_*` application parameters sourced from the env file
AND the explicit persistence keys (IAM_BAO_TOKEN, IAM_PG_URL, IAM_BAO_ADDR,
IAM_PUBLIC_ORIGIN) against the container's recorded env (`docker start` never reloads env;
the seed mode is forced by the run flag and image-baked defaults are immutable, so they
cannot drift - that is the comparison scope): a key REMOVED from the file but still baked
into the container is a divergence too (a stale secret would keep serving). A divergence
triggers a
coordinated same-image recreation through the updater instead of a plain start, and a
failed recreation fails the boot rather than serving a divergent environment. The `lyam`
container itself runs with
`--restart on-failure` so Docker's boot-time auto-restart cannot race the companions. The
reboot drill (`sudo reboot`, then verify pg/bao-unsealed/lyam came up in order and the data
survived) is part of qualifying a new host.

## Persistent companions

**PostgreSQL.** Versioned and executable: `deploy/oci/companions/docker-compose.yml` brings
up `pg` and `bao` on `lyam-net`. Prepare the bind-mounted host directories FIRST:
`sh deploy/oci/companions/prepare-dirs.sh` creates them owned by the image default user
(queried from the image itself, never hardcoded) - Docker auto-creates an absent bind
source as root:root and the unprivileged openbao container then cannot write it. Only then
(`PG_PASSWORD=<choice> docker compose -f docker-compose.yml up -d`,
password never committed). The API creates its `activations`/`decision_audit` tables itself at
first use; point `IAM_PG_URL=postgres://<user>:<password>@pg:5432/<db>` in `lyam.env` at it.
The host `bao` CLI (used by bao-bootstrap.sh and the unseal hook) belongs at
`/usr/bin/bao` on the VM, not `/bin/bao`.

**OpenBao.** Same compose file runs `bao server` with `deploy/oci/companions/bao.hcl` (file
storage on the host path `/opt/lyam/bao-storage`, loopback-only publication). Then
`deploy/oci/companions/bao-bootstrap.sh` initializes the backend ONCE (it refuses to
re-initialize), unseals it (safe to re-run after every bao restart - hook it into the host
boot; `--unseal-only` skips every init step), writes `deploy/oci/companions/bao-policy.hcl`,
enables the KV-v2 engine if needed, and mints a scoped token with an explicit 960 h (40-day)
TTL into a root-owned 0600 file (the granted TTL is measured at mint time, and a re-run only
reuses the stored token while its REMAINING lifetime covers the time left until the planned
demo end - `LYAM_DEMO_UNTIL`, default 2026-12-16 - never an arbitrary floor; the API never
renews tokens). A bounded listener wait (`BAO_WAIT_TRIES`, default 30 tries) absorbs a bao
that is still binding after a (re)start: an "unreachable" verdict is only legitimate after
the budget expires, never on the first probe. When it re-mints, the new token is synchronized ATOMICALLY into the app env
file (`LYAM_ENV_FILE`) and the script says loudly whether the running container must be
recreated (env edits never reach a running process; `docker restart` AND `docker start` do
not reload env - not even on a stopped container). The boot path enforces this: host-boot.sh
compares the env file against the container's recorded env before any `docker start`, and on
divergence it recreates the app through the updater's coordinated same-image redeploy (cold
backup, front gate, health gate) - the app never resumes with a divergent environment.
It never prints a secret. Constraints:

- Bao seals on every restart: keep the unseal key(s) and root token in a mode-0600 file
  on the host (that is what `bao-bootstrap.sh` produces) and unseal at boot (demo-grade;
  document where they live). An external secret manager would be the production answer -
  out of demo scope.
- Bringing the companions up must NEVER restart the Bao the running demo currently uses nor
  re-initialize anything: inventory and preservation come first (see the migration section),
  the companion stack only ever creates NEW services.
- Start order: `pg` up, `bao` up **and unsealed**, then `lyam`. The API reads
  `iam/pg` from Bao lazily and fails closed when Bao is unreachable; it never wipes
  anything on a Bao outage.
- The token the API gets (`IAM_BAO_TOKEN`) must be scoped to this policy (same paths as
  the built-in demo store, `demo/secret-store.mjs`):

  ```
  path "secret/data/iam/workflow-connections/*" { capabilities = ["create", "update", "read"] }
  path "secret/data/iam/plugins/*" { capabilities = ["create", "update", "read"] }
  path "secret/data/iam/pg" { capabilities = ["read"] }
  ```

  The API does NOT renew Bao leases (POC scope, `apps/api/src/integrations/secrets.service.ts`).
  The bootstrap requests 960 h and measures the granted TTL. Both new and reused tokens
  must cover the remaining time until `LYAM_DEMO_UNTIL` (default 2026-12-16). A valid
  stored token is reused, but a diverged `IAM_BAO_TOKEN` line in `LYAM_ENV_FILE` is repaired
  atomically, just as after a mint. The env file stays 0600; token values are never printed.
  A running app must be recreated from that file: Docker restart/start does not reload env.
  `host-boot.sh` detects this divergence and routes recreation through the guarded updater.
  `--unseal-only` never changes policy or tokens.

## Migrating the state of a running RAM-mode instance (first switch)

Before moving a live instance from the RAM fallbacks to the persistent companions,
**inventory first**; preserve whatever the inventory finds, and block the switch if
something recoverable cannot be migrated:

- Journal: read it from the running API (`GET /tenants/<tenant>/activations`, admin
  capability - the demo edge attaches it server-side). When empty, nothing to migrate.
  Otherwise insert the rows into the new PostgreSQL `activations` table (same tenant,
  seq, commit, state `recorded`) before the first `lyam` boot with `IAM_PG_URL`.
- Bao secrets: while the old container still runs, read them with the token the API itself
  uses. That token lives in the environment of the NestJS API process - the start script
  creates it AFTER its own launch and passes it to the API child, so PID 1 is NOT the right
  process. Identify the node process whose command runs `dist/main.js` (exactly one must
  match; if none or several do, STOP rather than guess), read its in-memory environment
  (e.g. `/proc/<pid>/environ`) for the Bao address and token, use them directly in the
  export requests, and never print or persist those values outside root-only files outside
  the repository. The scoped token cannot LIST keys: enumerate the known paths from the
  API/database side, and treat "no read error" as absence. Content the token cannot reach is
  unrecoverable by design - stop and report rather than dropping it silently. Report export
  results as status codes and path counts only, never secret values or error bodies that
  could carry them.
- Dolt data and the credential file already live on the volume: nothing to do.

An inventory on 2026-11-19 (before this pipeline existed) found an empty journal, no
workflow connections and no stored Bao secrets, so the first switch had nothing to
migrate. Re-run the inventory if the instance has been used since; do not treat that
dated result as a standing fact.

## Host boot ordering

At every host boot the companions must be READY before the app starts:
`deploy/oci/host-boot.sh` starts PostgreSQL and probes `pg_isready`, then starts OpenBao and
unseals it (`LYAM_BAO_UNSEAL_CMD`, i.e. `bao-bootstrap.sh --unseal-only`), then starts the
`lyam` container and health-checks it. A companion that never becomes ready stops the boot
instead of letting the app start against absent persistence. Install the ordering with
`deploy/oci/lyam-boot.service` (systemd oneshot, `After=docker.service`). An isolated reboot
drill of the whole chain remains part of the on-host validation before any switch.

## Updates

Manual, from the host (sudo: the updater reads the root-owned env file and the docker socket):

```sh
sudo sh update.sh --image ghcr.io/manudss/iam-platform-poc:<full-commit-sha>
```

Automatic (`.github/workflows/oci-deploy.yml`): after each successful main image build,
the workflow carries `update.sh` over SSH and runs it with the new SHA (via sudo). One-time
setup by the repository administrator, once the update path has been validated on the host:

1. On the host: `ssh-keygen -t ed25519 -f ~/.ssh/lyam-deploy` (no passphrase), append
   `lyam-deploy.pub` to `~/.ssh/authorized_keys`.
2. Repository secrets (GitHub > Settings > Secrets and variables > Actions):
   - `OCI_DEPLOY_SSH_HOST` - the host (IP or name);
   - `OCI_DEPLOY_SSH_USER` - the SSH user;
   - `OCI_DEPLOY_SSH_KEY` - the PRIVATE key `lyam-deploy` (kept in GitHub secrets only,
     never in the repo, an issue, a doc or a chat).
   Optional repository variable `OCI_DEPLOY_PUBLIC_ORIGIN` adds an outside `/healthz`
   check after each deploy.
3. Until the secrets exist the workflow ends green with a "skipped" note and deploys
   nothing.

## Backup and restore

Backups land in `LYAM_BACKUP_DIR` (default `/opt/lyam/backups`), kept
`LYAM_BACKUP_KEEP` generations per kind: `lyam-data-*.tar.gz`, `lyam-pg-*.sql.gz`,
`lyam-bao-*.tar.gz` (storage + unseal keys) and the private `lyam-recovery-*.tar.gz`
bundle (0600: env file, compose / bao config / policy, the updater profile itself -
scripts, boot unit and companions of the exact version that produced the archives, so a
rebuild never depends on a script outside the backup - and a manifest with the sha256 of
every artifact, the captured table state, and the mode/owner/secret flag of every bundled
file). Non-secret files keep their source mode/owner inside the bundle so a restore leaves
them readable by the container user; the env file and compose env are forced to root 0600
whatever their source mode. These LOCAL generations serve fast rollback on the
host. The durable
layer is the platform volume snapshot (see guarantee 6): the first snapshot exists
(2026-11-19, retention until 2026-12-16, verified to contain the cold application archive;
restoring the volume itself has not been drilled yet and it does not capture Bao RAM state).
Keep the two layers distinct in any recovery plan.

Restore (service stopped, consistent replay into a clean database):

```sh
rm -rf /opt/lyam/data && mkdir /opt/lyam/data
tar -C /opt/lyam -xzf /opt/lyam/backups/lyam-data-<ts>.tar.gz   # restores data/
docker exec pg psql -U lyam -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS "lyam"'
docker exec pg psql -U lyam -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "lyam"'
zcat /opt/lyam/backups/lyam-pg-<ts>.sql.gz | docker exec -i pg psql -U lyam -d lyam -v ON_ERROR_STOP=1 -q
tar -C / -xzf /opt/lyam/backups/lyam-bao-<ts>.tar.gz            # paths from LYAM_BACKUP_BAO_DIR/KEYS_DIR
```

Then boot with `IAM_DEMO_SEED_MODE=never`: with a dataset present the guard passes and
nothing is seeded. After the pg replay, verify the restored content (per-table count and
content hash, `SELECT count(*), md5(...) ... row_to_json(t) FROM activations`) against the
expectation for that backup before serving.

### Fresh-stack recovery (from the recovery bundle)

Qualification path for a full rebuild on a NEW host from `lyam-recovery-<ts>.tar.gz` plus
the data/pg/bao backups of the same generation:

1. Untar the bundle at `/` as root (`tar -C / -xzf lyam-recovery-<ts>.tar.gz` - root
   extraction preserves the recorded modes): the tree is preserved, so the env file,
   compose file, compose `.env` (PG password), bao config and policy, systemd unit, boot
   scripts and front-gate Caddy config all land at their original paths with the modes the
   manifest records (secrets 0600 root, non-secret files readable by their container user -
   verify against the manifest's `file mode=... owner=...` lines and re-apply any drift).
   The updater of this exact generation is under `updater/` in the bundle. Read `MANIFEST`
   for the image refs, backup names and their sha256.
2. Verify each backup against the manifest sha256 BEFORE restoring anything.
3. Install docker + the `bao` CLI (at `/usr/bin/bao`, not `/bin/bao`), create `lyam-net`,
   run the recovered `prepare-dirs.sh` (bind dirs owned by the image users), then bring the
   companions up with
   the recovered compose file and compose env (`docker compose --env-file <compose.env>
   -f <compose.yml> up -d`).
4. Initialize/unseal Bao with the recovered `bao-bootstrap.sh` and the recovered keys dir
   (the unseal keys are inside the bao backup's keys directory: restore it first).
5. Restore pg (drop/recreate/replay as above), restore the data tar, install the recovered
   systemd unit + `host-boot.sh`, put the front-gate Caddy snippet in place.
6. Boot with `IAM_DEMO_SEED_MODE=never` and verify the restored pg content against the
   manifest's `pg_state` (counts + content hashes + schema hash + sequence values).

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Moving tag (`latest`, `pr-12`) given | Refused, nothing touched |
| Image without the `never` seed label | Refused before the old container stops |
| Data directory empty/missing | Refused (bootstrap first) |
| Pause file present | Refused until removed |
| Another update running | Refused (host lock) |
| Pre-update hook (volume snapshot) fails | Aborted, previous container restarted |
| Backup fails (data tar, pg export, bao archive) | Update aborts, previous container restarted AND health-checked before the gate lifts (the gate never lifts over a booting app) |
| New container cannot be created | Compensation: data/pg/bao restored and verified, previous image started behind the front gate |
| New image never healthy | Same compensation (the front gate was never lifted for it) |
| A maintenance gate this run does not own already exists | Update refused (exit 1), the foreign marker is never touched |
| Front gate cannot be proven through the origin | Update refused (exit 1), nothing stops or starts |
| Healthy version but the front cannot be proven open | Maintenance RE-ARMED, service stays behind it, NO blind rollback, manual front diagnosis (exit 4) |
| Any failure after the gate went up | The gate STAYS UP on every fail-closed path (exit 4, interruption) |
| PostgreSQL restore or state verification fails in rollback | Service stays DOWN, postmortem dump kept, manual verification requested (exit 4) |
| Bao sealed/unready after its backup archive | Update aborts (preservation chain incomplete), previous container restarted once Bao is ready |
| Bao unseal/wait-ready fails in rollback | Service stays DOWN, manual unseal requested (exit 4) |
| Rollback never healthy | Backup restored, manual verification requested |
| Bao sealed/unreachable at boot | API fails closed on secret reads; no data is deleted |

## Validation status

The updater's tests run against a stubbed docker and qualify the SCRIPT LOGIC only. A real
update (actual image pull, boot, health, rollback) is qualified by an isolated on-host test
against a copy of the data before any switch of the live service.

### Repeatable real-service regressions

`deploy/oci/update.real-pg.mjs` exercises real PostgreSQL **17.12** (the version used in
this validation), including drop/recreate/replay, generated constraint/index names,
sequence restoration, and a refused DROP that must leave the app down. Supply a disposable
local server binary directory and matching 17.12 client binaries on PATH:

```sh
PG_BIN=/path/to/postgres-17.12/bin node deploy/oci/update.real-pg.mjs
```

The Docker/front commands are stubs in that harness; it does not qualify a full VM update.
`deploy/oci/companions/bao-bootstrap.real-test.sh` uses a real local OpenBao 2.7.2 on
port 18200, its own temporary storage, and no production credentials. Put `bao` on PATH:

```sh
sh deploy/oci/companions/bao-bootstrap.real-test.sh
```

It covers fresh initialization, restart/unseal, token reuse, divergent-env repair without
minting, dead-token replacement, unreachable listeners and refusal to reinitialize lost
storage with existing keys. These tests supplement, not replace, isolated VM qualification.
