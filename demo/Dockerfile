# All-in-one hosted-demo image (fictional data only). Build context = repository root.
# One container: Dolt sql-server + Rust core + NestJS API + Angular console (static, same-origin proxy).
# Optional pieces of the local stack (PostgreSQL journal, NATS, Temporal, OpenBao) are OFF here:
# the API runs on its in-memory fallbacks, documented in docs/demo.md.

FROM rust:1-bookworm AS corebuild
WORKDIR /src
COPY core/ core/
COPY policies/ policies/
COPY plugins/ plugins/
COPY proto/ proto/
RUN cd core && cargo build --release -p iam-core --locked

FROM node:22-bookworm-slim AS apibuild
WORKDIR /src
COPY apps/api/ apps/api/
RUN cd apps/api && npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS webbuild
WORKDIR /src
COPY apps/web/ apps/web/
RUN cd apps/web && npm ci && npx ng build --configuration production

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
ARG DOLT_VERSION=v2.6.1
RUN curl -sSfL "https://github.com/dolthub/dolt/releases/download/${DOLT_VERSION}/dolt-linux-amd64.tar.gz" | tar xz -C /opt \
 && ln -s /opt/dolt-linux-amd64/bin/dolt /usr/local/bin/dolt
WORKDIR /app
COPY --from=corebuild /src/core/target/release/iam-core /app/iam-core
COPY policies/ /app/policies/
COPY data/demo/ /app/data/demo/
COPY --from=apibuild /src/apps/api/dist /app/api/dist
COPY --from=apibuild /src/apps/api/node_modules /app/api/node_modules
COPY --from=apibuild /src/apps/api/package.json /app/api/package.json
COPY --from=webbuild /src/apps/web/dist /app/web/dist
COPY demo/server.mjs demo/start.sh /app/demo/
ENV IAM_DEMO_HOME=/data PORT=8080
EXPOSE 8080
CMD ["sh", "/app/demo/start.sh"]
