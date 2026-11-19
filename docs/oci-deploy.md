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
2. **Backup before every update.** Cold backup (container stopped) of the data directory,
   plus `pg_dumpall` of the PostgreSQL companion and a tar of the OpenBao storage when
   configured. A failed backup aborts the update and restarts the previous container.
3. **Health gate + rollback.** The new container must answer `/healthz` within
   `LYAM_HEALTH_TIMEOUT` seconds. Otherwise the previous image is restarted; if even that
   fails, the backup is restored into the data directory.
4. **Immutable versions only.** The updater accepts a full commit-SHA tag or a
   `@sha256:` digest - never a moving tag like `latest`.
5. **Deliberate freeze.** Creating the pause file (default `/opt/lyam/UPDATE_PAUSED`)
   blocks every update, manual or automatic, until it is removed.

## Topology

One docker network (`lyam-net`) with:

- `lyam` - the all-in-one image (Dolt + core + API + console), data on the host volume
  `/opt/lyam/data` mounted at `/data`, port published on loopback only
  (`127.0.0.1:8080`), HTTPS terminated by Caddy on the host.
- `pg` (optional) - PostgreSQL with its own volume: durable activation journal and
  decision audit via `IAM_PG_URL`.
- `bao` (optional) - OpenBao with file storage: durable plugin and workflow-connection
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
docker run -d --name lyam --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v /opt/lyam/data:/data \
  --env-file /opt/lyam/lyam.env --network lyam-net \
  -e IAM_DEMO_SEED_MODE=auto \
  ghcr.io/manudss/iam-platform-poc:<full-commit-sha>
```

After this first boot the dataset exists and every later start/update uses
`IAM_DEMO_SEED_MODE=never`. The updater refuses to run against a host that was never
bootstrapped.

## Persistent companions

**PostgreSQL.** Any small Postgres container on `lyam-net` with a named volume. The API
creates its `activations`/`decision_audit` tables itself at first use; point
`IAM_PG_URL=postgres://<user>:<password>@pg:5432/<db>` in `lyam.env` at it.

**OpenBao.** Run `bao server` with a file storage backend (its data dir on a host volume)
on `lyam-net`. Constraints:

- Bao seals on every restart: keep the unseal key(s) and root token in a mode-0600 file
  on the host and unseal at boot (demo-grade; document where they live). An external
  secret manager would be the production answer - out of demo scope.
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

  Prefer a renewable/periodic token: a short-lived non-renewable token silently cuts the
  API off its secrets when it expires.

## Migrating the state of a running RAM-mode instance (first switch)

Before moving a live instance from the RAM fallbacks to the persistent companions,
**inventory first**; preserve whatever the inventory finds, and block the switch if
something recoverable cannot be migrated:

- Journal: read it from the running API (`GET /tenants/<tenant>/activations`, admin
  capability - the demo edge attaches it server-side). When empty, nothing to migrate.
  Otherwise insert the rows into the new PostgreSQL `activations` table (same tenant,
  seq, commit, state `recorded`) before the first `lyam` boot with `IAM_PG_URL`.
- Bao secrets: while the old container still runs, its scoped token (visible in
  `/proc/1/environ` inside the container) can READ every
  `secret/data/iam/workflow-connections/*` and `secret/data/iam/plugins/*` key it
  created; copy each into the persistent Bao under the same paths. The scoped token
  cannot LIST keys: enumerate the known paths from the API/database side, and treat "no
  read error" as absence. Content the token cannot reach is unrecoverable by design -
  stop and report rather than dropping it silently.
- Dolt data and the credential file already live on the volume: nothing to do.

An inventory on 2026-11-19 (before this pipeline existed) found an empty journal, no
workflow connections and no stored Bao secrets, so the first switch had nothing to
migrate. Re-run the inventory if the instance has been used since; do not treat that
dated result as a standing fact.

## Updates

Manual, from the host:

```sh
sh update.sh --image ghcr.io/manudss/iam-platform-poc:<full-commit-sha>
```

Automatic (`.github/workflows/oci-deploy.yml`): after each successful main image build,
the workflow carries `update.sh` over SSH and runs it with the new SHA. One-time setup,
by the repo owner:

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
`lyam-bao-*.tar.gz`. Point `LYAM_BACKUP_DIR` at a durable/off-host mount when one is
available, or sync it after each run.

Restore (service stopped):

```sh
rm -rf /opt/lyam/data && mkdir /opt/lyam/data
tar -C /opt/lyam -xzf /opt/lyam/backups/lyam-data-<ts>.tar.gz   # restores data/
zcat /opt/lyam/backups/lyam-pg-<ts>.sql.gz | docker exec -i pg psql -U postgres   # when pg is used
tar -C / -xzf /opt/lyam/backups/lyam-bao-<ts>.tar.gz            # path from LYAM_BACKUP_BAO_DIR
```

Then boot with `IAM_DEMO_SEED_MODE=never`: with a dataset present the guard passes and
nothing is seeded.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Moving tag (`latest`, `pr-12`) given | Refused, nothing touched |
| Image without the `never` seed label | Refused before the old container stops |
| Data directory empty/missing | Refused (bootstrap first) |
| Pause file present | Refused until removed |
| Backup fails | Update aborts, previous container restarted |
| New image never healthy | Rollback to the previous image |
| Rollback never healthy | Backup restored into the data dir, manual verification requested |
| Bao sealed/unreachable at boot | API fails closed on secret reads; no data is deleted |
