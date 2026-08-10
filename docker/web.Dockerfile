FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/geo-core/package.json packages/geo-core/
COPY packages/store-contract/package.json packages/store-contract/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN pnpm install || true

# Development target: Vite dev server with hot reload, source bind-mounted by compose.
FROM deps AS dev
COPY . .
EXPOSE 5173
CMD ["pnpm", "--filter", "@wcad/web", "dev"]

# Production target: static build served by nginx, no Node in the runtime image.
FROM deps AS build
COPY . .
RUN pnpm --filter @wcad/web build

FROM nginx:1.27-alpine AS prod
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx/web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
