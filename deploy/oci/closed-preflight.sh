#!/bin/sh
set -eu
exec /opt/lyam/bin/closed-recovery-helper.py --mode preflight "$@"
