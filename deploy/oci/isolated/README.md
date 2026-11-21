# Isolated nominal qualification harness

Harness for the isolated nominal-qualification protocol (esquisse v2,
plan-qualification-nominale-isolee.md): prove on a REAL but ISOLATED update.sh cycle
that the repaired nominal path works end to end - policy declaring a digest-specific
verifier -> after-phase qualification -> gate lifted by update.sh itself - plus a
negative re-run proving fail-closed still holds without the verifier entry.

Runner: a host with NO production container, volume, network, account or file
(GitHub Actions runner via manual workflow_dispatch, or a scratch VM provided by the
infra operator). The demo VM is excluded: the controller's container discovery is
global (`docker ps`) and the pinned production verifier requires public TLS coverage.

Files:
- `run-isolated-cycle.sh` - the executable protocol: hard isolation refusals first
  (ISO_WORK disposable and never under /opt/lyam or /var/lib/lyam*, no production
  container names, no already-running verified image, barrier file explicitly inside
  ISO_WORK and never the script's production default, policy marker + no https origin,
  verifier pin verified), then the exact cycle: companions + bao bootstrap over docker
  exec, api-iso on the real OLD image (backend 127.0.0.1:8081), disposable Caddy front
  (127.0.0.1:8080), gate drill with explicit disposable barrier, verified preconditions,
  preflight, positive update.sh cycle, negative re-run on a FULLY REBUILT stack
  (compose down -v: fresh PG, fresh Bao, fresh data) without the verifier entry -
  expecting exactly update.sh's designed closed failure: exit 4, NEW image kept behind
  the re-armed gate, origin 503, missing-verifier cause in the log, NO rollback -
  then hashed evidence and cleanup.
- `run-qualification-isolated.sh` - LYAM_POST_UPDATE_CHECK wrapper; forwards update.sh's
  fixed arguments to qualification.py with `--isolated-loopback-test --policy
  $LYAM_ISOLATED_POLICY`; refuses an unset policy, the production policy path, and any
  policy without the `isolatedLoopbackTest: true` marker (a production policy copied
  under an innocent name still fails).
- `verify-0002-isolated-test.py` - isolated variant of the reviewed verifier V7 for the
  same single image transition. Deltas (only): ISOLATED_LOOPBACK_NO_PUBLIC_TLS_PROOF
  coverage, policy from LYAM_ISOLATED_POLICY (production path refused), siblings in the
  parent directory. Installed on the runner root-owned 0700 and pinned by sha256 in the
  test policy + preflight, like the production procedure.
- `verify-0002-isolated-test.test.py`, `run-qualification-isolated.test.py` - suites.
- `lyam.isolated.env.example` - complete update.sh environment template (every required
  LYAM_* key, including COMPOSE_FILE/COMPOSE_ENV_FILE/BAO_CONFIG_FILE/BAO_POLICY_FILE/
  STACK_FILES/BAO_UNSEAL_CMD); rendered by the orchestrator, fictive values only.
- `docker-compose.isolated.yml`, `bao.hcl`, `bao-policy.hcl` - the real companion +
  front manifest (pg-iso, bao-iso, caddy-iso; lyam-iso-net; ISO_WORK interpolation).
- `bao-bootstrap-isolated.sh`, `bao-unseal-isolated.sh` - OpenBao init (fictive 1/1
  shares)/unseal/policies/tokens over docker exec (no host bao CLI on a fresh runner);
  TWO scoped tokens: the app token (policy api, into IAM_BAO_TOKEN) and a SEPARATE
  qualification metadata token (policy qualification-metadata, bao-policy-metadata.hcl)
  that the capture uses as baoTokenFile; refuse production paths. Writes ONE persistent
  fictive sentinel key (secret/iam/qualification-sentinel, only if absent) so the
  covered metadata inventory is never empty: LIST on an empty path answers 404 by
  design (openbao/openbao#213), which would fail the capture UNKNOWN (stage=BAO_WALK).
- `../../.github/workflows/isolated-nominal.yml` - the reviewable job: workflow_dispatch
  only, permissions contents:read, standard ubuntu-latest, no environment, no secrets,
  checkout without persisted credentials, hashed evidence upload.
- `qualification.isolated.example.json` - test policy BUILT FROM SCRATCH (never a copy
  of the live one): -iso containers, lyam-iso-net, loopback origins,
  `isolatedLoopbackTest: true`, fictive secrets, verifier entry for the NEW image digest.
- `Caddyfile.isolated` - disposable loopback front; its gate semantics are proven by
  `front-barrier-check.sh`, not by assertion.

Cycle (all commands reviewed before execution; no production access):
0. Preconditions: isolated stack seeded by the real OLD image; ledger stopped at 0001,
   activation baseline, no account-blocks rule - verified, not assumed.
1. `front-barrier-check.sh` with `IAM_PUBLIC_ORIGIN=http://127.0.0.1:8080` proves the
   throwaway front's gate.
2. Test policy + pinned test verifier installed;
   `update-preflight.py --image <NEW> --policy <test policy> --verifier-sha256 <pin>`
   must pass.
3. `update.sh --require-qualification` with the isolated env file and
   `LYAM_ISOLATED_POLICY=<test policy>` exported for the wrapper; target = real NEW image.
   Expected: after-phase PASS through the test verifier, gate lifted by update.sh itself.
4. Negative re-run from a FRESH copy of the BEFORE state, same policy minus the
   transformationVerifiers entry: must fail closed, gate still armed.
5. Evidence archived and hashed: before/after captures, smoke, verifier output, logs.

Reduced proof, stated plainly: no public TLS (loopback only), update.sh alone (the
ordered queue is out of scope), seed data rather than the incident's captured values.
What it qualifies is the nominal chain; it authorizes no production deploy by itself.
