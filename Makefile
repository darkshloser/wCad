# Every target runs inside Docker. No host toolchain required beyond Docker itself.
#
# `--profile tools` is a top-level flag and must come BEFORE the subcommand — putting it after
# `run` is silently accepted by some Compose versions and rejected by others.
COMPOSE := docker compose
TOOLS := docker compose --profile tools
TILES_URL ?= http://localhost:$(or $(TILES_PORT),3001)
FILE ?= fixtures/small.dxf

.PHONY: help up down logs ps test test-watch test-integration typecheck lint depcruise \
        shell psql valkey seed bench tile-metrics projects verify e2e fixtures fixture-large \
        flush-tiles test-workers import import-bench migrate migrate-status clean

help:
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

## ---------------------------------------------------------------- stack

up: ## Start the full stack
	@echo "Resolving dependencies (one-time lockfile bootstrap)..."
	@# Every service below bind-mounts this same host directory, including pnpm-lock.yaml. If each
	@# service's own entrypoint tried to generate that file itself, containers starting together
	@# would race to write it concurrently. Doing it once here, sequentially, first, means every
	@# service's entrypoint can safely treat the lockfile as read-only afterward. Cheap to repeat:
	@# if the lockfile already matches, this is a fast no-op.
	$(TOOLS) run -e WCAD_BOOTSTRAP=1 --build --rm test pnpm install --no-frozen-lockfile
	$(COMPOSE) up -d --build
	@echo "Applying schema migrations..."
	@# init.sql only runs on an empty data directory; migrations are how a schema change reaches
	@# a database that already exists. Idempotent, so running it every time is safe.
	$(COMPOSE) run --rm workers python -m wcad_workers.migrate
	@echo ""
	@echo "  web     http://localhost:$(or $(WEB_PORT),5173)"
	@echo "  tiles   http://localhost:$(or $(TILES_PORT),3001)/health"
	@echo "  api     http://localhost:$(or $(API_PORT),3000)/health"
	@echo ""
	@echo "  next:   make seed        (load a fixture)"
	@echo "          make verify      (run the Phase 2 exit gate)"

down: ## Stop everything
	$(COMPOSE) down

ps: ## Show service status
	$(COMPOSE) ps

logs: ## Tail logs from all services
	$(COMPOSE) logs -f

## ---------------------------------------------------------------- tests

test: ## Unit, property and contract tests (no Docker-in-Docker needed)
	$(TOOLS) run --build --rm test pnpm test

test-watch: ## Tests in watch mode
	$(TOOLS) run --build --rm test pnpm test:watch

test-integration: ## Testcontainers suites against a real PostGIS (needs the Docker socket)
	$(TOOLS) run --build --rm test pnpm vitest run --config vitest.integration.config.ts

typecheck: ## Project-wide TypeScript check
	$(TOOLS) run --build --rm test pnpm typecheck

lint: ## Lint
	$(TOOLS) run --build --rm test pnpm lint

depcruise: ## Enforce architectural boundaries (guardrail G1)
	$(TOOLS) run --build --rm test pnpm depcruise

test-workers: ## Python worker suites against real PostGIS
	$(COMPOSE) run --build --rm workers pytest -q

e2e: ## Playwright render-budget tests against the running stack
	$(TOOLS) run --build --rm e2e pnpm --filter @wcad/web exec playwright test

## ---------------------------------------------------------------- data

fixtures: ## Generate the standard fixture set
	$(TOOLS) run --build --rm test pnpm fixtures:generate

fixture-large: ## Generate the 10M-entity fixture (~1.4 GB, a few minutes)
	$(TOOLS) run --build --rm test pnpm fixtures:generate --entities 10000000 --out large.dxf

seed: ## Load a fixture into PostGIS (FILE=fixtures/small.dxf)
	@# `run` on the tooling container, not `exec` on the tile service: exec skips the image
	@# ENTRYPOINT, so it depends on that long-running container having relinked correctly at start.
	$(TOOLS) run --rm -e TILES_URL=http://tiles:3001 test \
		node --experimental-strip-types tools/seed/loadFixture.ts --file $(FILE)

import: ## Import a DXF through the real pipeline (FILE=fixtures/small.dxf)
	$(COMPOSE) run --build --rm workers \
		python -m wcad_workers.main import --file $(subst fixtures/,/fixtures/,$(FILE))

import-bench: ## Phase 3 exit gate: import 10M entities against the budgets
	@# Present is not the same as usable: a fixture written before the DXF writer was fixed declares
	@# AC1009 while containing R2000 entities, and a real reader rejects it part-way through.
	@if ! head -40 fixtures/large.dxf 2>/dev/null | grep -q AC1015; then \
		echo "large.dxf missing or predates the DXF writer fix; regenerating"; \
		$(TOOLS) run --build --rm test pnpm fixtures:generate --entities 10000000 --out large.dxf; \
	fi
	$(COMPOSE) run --build --rm workers python -m wcad_workers.main import \
		--file /fixtures/large.dxf --name large-import-bench --budgets

## ---------------------------------------------------------------- measurement

migrate: ## Apply pending schema migrations
	$(COMPOSE) run --rm workers python -m wcad_workers.migrate

migrate-status: ## Show which migrations are applied
	$(COMPOSE) run --rm workers python -m wcad_workers.migrate status

flush-tiles: ## Clear both tile cache tiers (needed before a meaningful bench)
	@# Both tiers, or the cold tier silently repopulates the hot one with the same stale bytes.
	$(COMPOSE) exec valkey valkey-cli FLUSHALL
	$(COMPOSE) exec tiles sh -c 'rm -rf /var/lib/wcad/objects/tiles/* 2>/dev/null; echo cleared'

bench: ## Benchmark the tile service against the Phase 2 budgets
	$(TOOLS) run --rm -e TILES_URL=http://tiles:3001 test \
		node --experimental-strip-types tools/bench/tileBench.ts --url http://tiles:3001

tile-metrics: ## Show tile cache counters
	@curl -s $(TILES_URL)/metrics

projects: ## List projects known to the tile service
	@curl -s $(TILES_URL)/projects

verify: ## Phase 2 exit gate: unit + integration + budgets, end to end
	@echo "== 1/4 unit, property and contract tests =="
	@$(MAKE) --no-print-directory test
	@echo ""
	@echo "== 2/4 integration tests against real PostGIS =="
	@$(MAKE) --no-print-directory test-integration
	@echo ""
	@echo "== 3/4 tile service reachable =="
	@curl -fsS $(TILES_URL)/health && echo ""
	@echo ""
	@echo "== 4/4 performance budgets =="
	@# Flush first: a cached tile is served exactly as it was built, so without this the gate
	@# measures whatever the last run left behind and reports zero cache misses as a pass.
	@$(MAKE) --no-print-directory flush-tiles
	@$(MAKE) --no-print-directory bench

## ---------------------------------------------------------------- shells

shell: ## Shell into the tooling container
	$(TOOLS) run --build --rm test bash

psql: ## psql into the database
	$(COMPOSE) exec postgis psql -U $${POSTGRES_USER:-wcad} -d $${POSTGRES_DB:-wcad}

valkey: ## valkey-cli against the running cache
	$(COMPOSE) exec valkey valkey-cli

clean: ## Stop and remove volumes (destroys local data)
	$(COMPOSE) down -v
