# Shared Node base for every JS/TS service.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# Dependency layer: copied first so an application code change does not reinstall packages.
FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/geo-core/package.json packages/geo-core/
COPY packages/store-contract/package.json packages/store-contract/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS dev
COPY . .
