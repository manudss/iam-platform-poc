# syntax=docker/dockerfile:1
# Local development image for the app container (infra/docker-compose.dev.yml): Rust toolchain +
# Node 22 in ONE container. The sign-in gate (core -> API) is loopback-only by design
# (crates/iam-core refuses a non-loopback IAM_AUTH_GATE_ADDR), so the core and the API must share
# the container's loopback. The console runs in its own node:22 container (web service).
FROM node:22-bookworm AS node
FROM rust:1-bookworm
COPY --from=node /usr/local/ /usr/local/
