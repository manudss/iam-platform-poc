#!/bin/sh
# deploy/oci/companions/prepare-dirs.sh — create the host directories bind-mounted by
# docker-compose.yml with the ownership the services ACTUALLY run as, BEFORE the first
# `docker compose up`.
#
# Why: Docker auto-creates a missing bind-mount source as root:root, and the openbao
# container runs as its own unprivileged user - it then cannot write /bao/file and the
# install fails on permissions. Preparing the directory from the IMAGE ITSELF (its default
# user's uid/gid, queried at prepare time) keeps this reproducible across image bumps.
#
# Idempotent: re-running fixes ownership of an existing directory. Covers installation from
# an ABSENT directory (the common first-install case).
#
# Usage: prepare-dirs.sh [bao-image] [bao-host-dir]
set -eu

BAO_IMAGE="${1:-openbao/openbao:2.7.2}"
BAO_DIR="${2:-/opt/lyam/bao-storage}"

command -v docker >/dev/null 2>&1 || { echo "docker not found on this host" >&2; exit 1; }

# The image's DEFAULT user owns the storage: ask the image, never hardcode a uid.
BAO_UID="$(docker run --rm --entrypoint id "$BAO_IMAGE" -u)" \
  || { echo "could not read the default uid of $BAO_IMAGE" >&2; exit 1; }
BAO_GID="$(docker run --rm --entrypoint id "$BAO_IMAGE" -g)" \
  || { echo "could not read the default gid of $BAO_IMAGE" >&2; exit 1; }
case "$BAO_UID$BAO_GID" in *[!0-9]*) echo "unexpected uid/gid from $BAO_IMAGE: $BAO_UID/$BAO_GID" >&2; exit 1 ;; esac

install -d -m 700 -o "$BAO_UID" -g "$BAO_GID" "$BAO_DIR"
echo "prepared $BAO_DIR (0700, owner $BAO_UID:$BAO_GID from $BAO_IMAGE default user)"
