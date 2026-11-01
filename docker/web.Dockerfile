FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml .npmrc pnpm-lock.yaml* ./
# Every workspace package.json, in every image, deliberately.
#
# These lists used to differ per image, which broke builds twice: the root package.json depends on
# all of them (tools/ scripts resolve through the root), so a missing one fails the whole install
# with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. Keeping the stage identical everywhere costs a little
# image size in dev and removes an entire class of bug. Production targets serve static assets and
# ship no node_modules at all.
COPY packages/geo-core/package.json packages/geo-core/
COPY packages/store-contract/package.json packages/store-contract/
COPY packages/tiling/package.json packages/tiling/
COPY packages/store-postgis/package.json packages/store-postgis/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/tiles/package.json apps/tiles/
COPY tools/package.json tools/
# No `|| true`: a failed install must fail the build. Masking it produces an image that starts
# fine and then dies on a confusing module-resolution error at runtime.
RUN pnpm install --no-frozen-lockfile

# Development target: Vite dev server with hot reload, source bind-mounted by compose.
FROM deps AS dev
COPY . .
COPY docker/entrypoint-dev.sh /entrypoint-dev.sh
RUN chmod +x /entrypoint-dev.sh
ENTRYPOINT ["/entrypoint-dev.sh"]
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
