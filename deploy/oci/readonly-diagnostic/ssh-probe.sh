#!/usr/bin/env bash
# Inert single-session SSH probe. No stdin payload, no sudo, no remote shell composition.
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
rc=0
timeout 45 ssh -vvv -i "$HOME/.ssh/oci_diag" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$HOME/.ssh/known_hosts_oci_diag" "$OCI_SSH_USER@$OCI_SSH_HOST" /usr/bin/true < /dev/null > "$work/out" 2> "$work/trace" || rc=$?
python3 "$here/ssh-probe-filter.py" "$work/trace" "$work/out" "$rc"
