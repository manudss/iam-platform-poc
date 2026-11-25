# Normal updater adapter, draft and not host-ready

This branch is stacked on PR187. Its delta contains only update.sh normal-mode
integration, normal-runtime.py, normal-lifecycle.py and their focused tests.
No release controller, journal format migration, host boot, qualification policy,
SSH installation or environment change is included. Do not merge PR186 wholesale.

Evidence on identical source files: disposable run45720257723, artifact15071737922.
Actual updater shell exited0, created a cold Dolt archive, preserved old container,
launched through namespace FIFO, completed lifecycle and reopened local fixture
front. Dolt/PostgreSQL/Bao were real synthetic stores. Same exact app image was
used throughout. The qualification checker was a fixture testing stopped-before
and running-after only, NOT qualification.py/OIDC/full preservation. PG and Bao
archive paths were not exercised; Bao dev mode is not durable restart evidence.
No new-SHA ordered queue or boot proof exists. Full host readiness remains open.

Installed code would require protected root-owned exact files and explicit env:
LYAM_NORMAL_RUNTIME is a protected normal profile JSON; LYAM_NORMAL_RUNTIME_SHA256
binds it; LYAM_NORMAL_LIFECYCLE_SHA256 and LYAM_NORMAL_LAUNCHER_SHA256 bind installed
code. LYAM_QUALIFICATION_POLICY selects a separately reviewed normal policy at the
operational path, not the fixture checker. Keep pause and both gates in place
until initial release is separately reviewed and qualified. This branch provides
no authority to remove HOLD, remove pause, replace policy or open access.

Future app container should reuse the exact current held container name only
when the reviewed release algorithm observes/preserves that container and starts
normal under the same name. Never use a shorthand copied from a report. Operator
must verify actual full identity immediately before any install or effect.

The normal launcher accepts only exact two-network topology, fixed private PG/Bao,
immutable image/revision, seednever/HOLD absent, inherited lock and protected env.
It installs namespace rules and checks network/capabilities before FIFO release.
The effects marker precedes that first app instruction. Failures keep access
gated, stop the candidate and never automatically restart old app or restore data.
Normal boot remains unimplemented in PR186 and is not implemented here.
