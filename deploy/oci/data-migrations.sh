#!/bin/sh
# Run INSIDE an otherwise stopped-data-volume image; only offline status/adoption commands.
# Mount the real data at /data for execution ONLY after qualification/approval.
set -eu
case "${1:-}" in status|plan-adoption|adopt-existing-v1) ;; *) echo 'Only status/plan-adoption/adopt-existing-v1 are operator commands' >&2; exit 1 ;; esac
HOME_DIR="${IAM_DEMO_HOME:-/data}"
[ -d "$HOME_DIR/dolt" ] || { echo 'Existing data volume required' >&2; exit 1; }
export IAM_MIGRATION_SOURCE_ROOT="${IAM_MIGRATION_SOURCE_ROOT:-/app/migration-source}"
exec flock --nonblock "$HOME_DIR/.boot.lock" node /app/api/dist/migrations/cli.js "$@"
