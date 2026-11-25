# OCI active-root SSH dispatch, operator installation required

PR changes a runtime/deployment interface, not tests only. No installation or
merge is authorized by this document. Keep queue paused and access maintenance
until the normal runtime/updater path is qualified.

The remote strings lyam-status and lyam-drain are protocol tokens. They are NOT
PATH binaries. A dedicated deployment authorized_keys entry must force a fixed
root dispatcher. SSH_ORIGINAL_COMMAND is accepted only when exactly one token;
no shell eval, user path, arbitrary args, newline or wildcard. Dedicated key must
have restrict (or equivalent no-port/agent/X11 forwarding, no-pty,no-user-rc).
Use a dedicated account/key, not a general operator key whose access is widened.

Install reviewed ci-dispatch.py and release-paths.py in protected active/bin,
root-owned unique regular files, root-only write ancestry; dispatcher executable.
Fixed root=/opt/lyam-recovery/active. lyam.env root0600 must bind all operational
paths, queue, pause, updater, lock and policy. Dispatcher is a forced command,
not a normal command found from the noninteractive user's PATH.

For nonroot SSH, install a root-owned no-argument launcher that preserves only
SSH_ORIGINAL_COMMAND into the root dispatcher via a narrow sudo rule. Review
actual sudo -V/env_keep behavior or use a dedicated root forced-key entry instead;
do not assume sudo preserves this variable. Never grant arbitrary python/shell
sudo or pass unvalidated command text as root arguments. No generic installation
command is supplied because account/key/forced-command facts remain operator
preflight evidence. If no safe route exists, refuse, do not silently use legacy.

Dispatcher root-checks itself, reads only fixed protected active files, validates
paths with release-paths.py, and invokes fixed ordered-queue.py status/drain with
explicit state/pause/update-lock/updater/env-file. Child stdin/stdout/stderr are
inherited unchanged, exit code propagated including refusal10; environment is
PATH=/usr/sbin:/usr/bin:/sbin:/bin,HOME=/root,LANG=C.UTF-8. Drain receives the exact
qualified plan on stdin, no shell and no argv input paths. Queue remains the
validator of plan/schema/order and the owner of locks and pause refusals.

Before readiness, operator returns hashes/owners/modes/ancestry of dispatcher,
release-paths,queue,updater and env; authorized-key restrictions and root route
without key bytes; fixed operational paths and current pause/state. Using the
SAME CI key and noninteractive SSH transport, show lyam-status routes to the
expected active queue (paused refusal is acceptable evidence, not deploy ready),
invalid token refuses, no shell/forwarding, and empty or malformed drain input
refuses without changing state. Only later send a qualified plan as a real deploy.
No pause removal, gate change, updater install or SSH key change is implicit.

Local tests include exact token refusals, explicit path/env propagation, real
child stdin/stdout/exit10/environment contract, and main inheriting standard
streams with shell disabled. Actual SSH/authorized_keys/sudo route is NOT tested
locally. Revert this PR only reverts workflow tokens, not a host transaction;
first pause queue and keep gates closed if transport or update fails.

## Proposed dedicated account contract, no host installation implied

The existing ubuntu operator key has broad sudo and no forced command. It must
NOT become the CI key, be copied into GitHub secrets, or be narrowed in place.
Root SSH login is disabled on the observed host, so direct root-key installation
is not the chosen route.

Prepare a separate deployment account and separately generated CI key. Its one
root-owned authorized_keys entry uses restrict and a forced command that invokes
sudo noninteractively for ONLY the fixed root-owned dispatcher, with no command
arguments. Account cannot write its authorized_keys, dispatcher, active root,
sudo policy or parent directories. Keep operator ubuntu access unchanged.
SSH must preserve the requested protocol token as SSH_ORIGINAL_COMMAND through
that exact sudo command. The sudo rule must use command-scoped env_keep for
SSH_ORIGINAL_COMMAND, with no general SETENV, shell, Python interpreter, env
binary, wildcard arguments or broader passwordless rights. Dispatcher rejects
all values except the two exact tokens before invoking the queue. If installed
sudo cannot provide this exact scope, stop for an alternative reviewed helper;
do not compensate by accepting arguments or granting arbitrary environment.

Operator evidence must show the effective dedicated account SSH configuration,
forced command and sudo listing without key material; all ownership/modes; and
actual noninteractive transport proving the variable survives with no extra
sudo arguments. Test the same dedicated CI key, not the operator key. An empty,
multiline or shell-like token must refuse without a queue mutation. A normal
interactive shell, forwarding and PTY must not be available. Key generation,
GitHub secret replacement and host account/policy installation are separate
coordinated steps, not performed or authorized by this contract.

Required active env bindings remain exactly release-paths.plan output. Existing
live env is not presumed to contain them. Operator should return key-presence
and reviewed path values only, never application secrets. Missing path bindings
must be staged and reviewed as an explicit env migration before readiness.
