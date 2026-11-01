#!/bin/sh
# Dev-container entrypoint (web, api, tiles, test images).
#
# Every dev service bind-mounts the whole repo (`.:/app` in docker-compose.yml) over the image,
# and protects only ONE path from that mount: a named volume at /app/node_modules. pnpm always
# symlinks a workspace dependency (e.g. `@wcad/store-postgis`) into the *consuming* package's own
# node_modules -- packages/store-contract/node_modules, apps/tiles/node_modules, and so on -- not
# into the hoisted root, regardless of the `node-linker=hoisted` setting in .npmrc (that setting
# only affects third-party dependencies, not workspace links). None of those per-package
# directories are covered by a volume, so the bind mount blanks them out at container start, and
# the service dies on ERR_MODULE_NOT_FOUND the moment it imports a sibling package.
#
# The fix is not to enumerate and volume-protect every package's node_modules -- that list changes
# every time a package is added, which is exactly the class of bug this project has hit
# repeatedly. Instead, re-link here, after the mounts are already in place.
#
# --frozen-lockfile --offline, never --no-frozen-lockfile: every service bind-mounts the SAME host
# directory, including pnpm-lock.yaml, so containers starting together (web, api and tiles all come
# up at once) would race to write that one file. `wcad.ps1 up` / `make up` generate it exactly
# once, in a single container, before the stack starts; everything after that only reads it.
#
# The actual downloaded packages live in /app/node_modules/.pnpm, which the named volume *does*
# cover, so this relink resolves entirely from local cache -- no network, ~2 seconds.
set -e

# Step aside when the command IS the lockfile bootstrap.
#
# ENTRYPOINT always wraps CMD, so a relink here runs *before* the bootstrap and would demand the
# very lockfile that command exists to create or update. Checking only whether the file exists is
# not enough: adding a dependency leaves a lockfile that is present but stale, and the frozen
# relink then fails and blocks the one command that would fix it.
#
# WCAD_BOOTSTRAP is set explicitly by `wcad.ps1 up` / `make up`. The argument check is a safety net
# for anyone running `docker compose run ... pnpm install` by hand.
if [ "$WCAD_BOOTSTRAP" = "1" ] || { [ "$1" = "pnpm" ] && [ "$2" = "install" ]; }; then
  echo "[entrypoint] bootstrap run; skipping relink"
  exec "$@"
fi

if [ ! -f /app/pnpm-lock.yaml ]; then
  echo "[entrypoint] no pnpm-lock.yaml yet; skipping relink"
  exec "$@"
fi

# A failure here is nearly always a stale lockfile after a dependency change, so say so plainly
# rather than leaving a raw pnpm error to be decoded.
if ! pnpm install --offline --frozen-lockfile; then
  echo "[entrypoint] relink failed -- pnpm-lock.yaml is probably out of date with package.json." >&2
  echo "[entrypoint] Regenerate it by restarting the stack:  wcad.ps1 up   (or: make up)" >&2
  exit 1
fi

exec "$@"
