FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/geo-core/package.json packages/geo-core/
COPY packages/store-contract/package.json packages/store-contract/
COPY apps/api/package.json apps/api/
RUN pnpm install || true

FROM deps AS dev
COPY . .
EXPOSE 3000
CMD ["pnpm", "--filter", "@wcad/api", "dev"]
