# syntax=docker/dockerfile:1
# All-in-one hosted-demo image (fictional data only). Build context = repository root.
# One container: Dolt sql-server + Rust core + NestJS API + Angular console (static, same-origin proxy).
# Core bus: a local nats-server runs INSIDE this container (loopback, per-boot random password; required for API startup).
# Optional pieces of the local stack (PostgreSQL journal, Temporal, OpenBao) are OFF here:
# the API runs on its in-memory fallbacks, documented in docs/demo.md.
#
# BuildKit cache mounts (cargo registry + target, npm cache) make REBUILDS on
# warm runners (GitHub Actions cache, see .github/workflows/demo-image.yml) much
# faster: only the changed crate/npm work is redone instead of full cold builds.
# They are no-ops for correctness on any BuildKit builder (Render included).

FROM rust:1-bookworm AS corebuild
WORKDIR /src
COPY core/ core/
COPY policies/ policies/
COPY plugins/ plugins/
COPY proto/ proto/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/core/target \
    cd core && cargo build --release -p iam-core --locked \
 && cp target/release/iam-core /iam-core-bin

FROM node:22-bookworm-slim AS apibuild
WORKDIR /src
COPY apps/api/ apps/api/
COPY scripts/ scripts/
COPY plugins/ plugins/
# The plugins' controlled shared install (step 4): the root package.json is generated from their declarations.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    cd apps/api && npm ci && npm run build && npm prune --omit=dev
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && node scripts/plugin-deps.mjs && node scripts/plugin-deps.mjs --check
# Demo signing keys are generated AT BUILD (never committed): the plugins are signed here and only the PUBLIC
# trust store reaches the final image. The private key (conf/plugin-dev-key.json) stays in this build stage.
RUN node scripts/plugin-dev-setup.mjs

FROM node:22-bookworm-slim AS webbuild
WORKDIR /src
COPY apps/web/ apps/web/
RUN --mount=type=cache,target=/root/.npm \
    cd apps/web && npm ci && npx ng build --configuration production

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
ARG DOLT_VERSION=v2.6.1
RUN curl -sSfL "https://github.com/dolthub/dolt/releases/download/${DOLT_VERSION}/dolt-linux-amd64.tar.gz" | tar xz -C /opt \
 && ln -s /opt/dolt-linux-amd64/bin/dolt /usr/local/bin/dolt
ARG NATS_VERSION=v2.15.2
RUN curl -sSfL "https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-linux-amd64.tar.gz" | tar xz -C /opt \
 && ln -s /opt/nats-server-${NATS_VERSION}-linux-amd64/nats-server /usr/local/bin/nats-server
WORKDIR /app
COPY --from=corebuild /iam-core-bin /app/iam-core
COPY policies/ /app/policies/
COPY conf/nats-local.conf /app/conf/nats-local.conf
COPY data/demo/ /app/data/demo/
COPY --from=apibuild /src/apps/api/dist /app/api/dist
COPY --from=apibuild /src/apps/api/node_modules /app/api/node_modules
COPY --from=apibuild /src/apps/api/package.json /app/api/package.json
COPY --from=apibuild /src/node_modules /app/node_modules
# Step 4: the host-provided @nestjs/common symlink inside node_modules is relative to the BUILD layout
# (/src/node_modules -> /src/apps/api/...); in this image the API lives at /app/api, so recreate the link
# for the /app layout or every plugin importing @nestjs/common crashes the API at boot (MODULE_NOT_FOUND).
RUN ln -sfn ../../api/node_modules/@nestjs/common /app/node_modules/@nestjs/common
# Signed plugin packages + the PUBLIC trust store (P0-6): the API refuses to boot without them (P0-3).
COPY --from=apibuild /src/plugins /app/plugins
COPY --from=apibuild /src/conf/plugin-trust.json /app/conf/plugin-trust.json
COPY --from=webbuild /src/apps/web/dist /app/web/dist
COPY demo/server.mjs demo/start.sh demo/public-redirect-uris.mjs /app/demo/
ENV IAM_DEMO_HOME=/data PORT=8080 IAM_PLUGINS_DIR=/app/plugins IAM_PLUGIN_TRUST=/app/conf/plugin-trust.json
# Free-tier hosts (shared CPU) make every bus delivery slow (activity checks read Dolt on each one): give the
# plugin hook calls and the core's gate client much larger budgets than the local defaults. Fail-closed
# semantics are unchanged - a real timeout still refuses the sign-in.
ENV IAM_HOOK_TIMEOUT_MS=8000 IAM_GATE_TIMEOUT_MS=30000
EXPOSE 8080
CMD ["sh", "/app/demo/start.sh"]
