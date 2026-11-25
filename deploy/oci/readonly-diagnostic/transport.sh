#!/usr/bin/env bash
# Runner-only transport. Never prints raw SSH stdout/stderr. Remote script uses stdin.
set -euo pipefail
case "${1:-}" in host|inventory) mode=$1;; *) exit 2;; esac
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
printf 'transport.local_enter=true\n'
if [ "$mode" = host ]; then
  source_file="$here/host.sh"
  remote='printf "transport.remote_enter=true\n"; sudo -n sh -c '\''printf "transport.sudo_enter=true\n"; timeout 50 sh -s; r=$?; printf "transport.payload_exit=%s\n" "$r"; exit "$r"'\''; r=$?; printf "transport.sudo_exit=%s\n" "$r"; exit "$r"'
else
  source_file="$here/inventory.cjs"
  remote='printf "transport.remote_enter=true\n"; sudo -n sh -c '\''printf "transport.sudo_enter=true\n"; timeout 50 docker exec -i -w /app/api lyam node -; r=$?; printf "\ntransport.payload_exit=%s\n" "$r"; exit "$r"'\''; r=$?; printf "transport.sudo_exit=%s\n" "$r"; exit "$r"'
fi
rc=0
timeout 60 ssh -i "$HOME/.ssh/oci_diag" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$HOME/.ssh/known_hosts_oci_diag" "$OCI_SSH_USER@$OCI_SSH_HOST" "$remote" < "$source_file" > "$work/out" 2> "$work/err" || rc=$?
# Filter before anything is sent to the public runner log.
python3 "$here/filter.py" "$mode" "$work/out" "$work/err" "$rc"
