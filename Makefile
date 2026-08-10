# Every target runs inside Docker. No host toolchain required beyond Docker itself.
COMPOSE := docker compose

.PHONY: help up down logs test test-watch typecheck lint depcruise shell psql valkey fixtures clean

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Start the full stack (web on http://localhost:5173)
	$(COMPOSE) up -d --build
	@echo "web:     http://localhost:5173"
	@echo "api:     http://localhost:3000/health"

valkey: ## valkey-cli against the running cache
	$(COMPOSE) exec valkey valkey-cli

down: ## Stop everything
	$(COMPOSE) down

logs: ## Tail logs from all services
	$(COMPOSE) logs -f

test: ## Run the full test suite in a container
	$(COMPOSE) run --rm --profile tools test pnpm test

test-watch: ## Run tests in watch mode
	$(COMPOSE) run --rm --profile tools test pnpm test:watch

typecheck: ## TypeScript project-wide typecheck
	$(COMPOSE) run --rm --profile tools test pnpm typecheck

lint: ## Lint
	$(COMPOSE) run --rm --profile tools test pnpm lint

depcruise: ## Enforce architectural boundaries (guardrail G1)
	$(COMPOSE) run --rm --profile tools test pnpm depcruise

shell: ## Shell into the tooling container
	$(COMPOSE) run --rm --profile tools test bash

psql: ## psql into the database
	$(COMPOSE) exec postgis psql -U $${POSTGRES_USER:-wcad} -d $${POSTGRES_DB:-wcad}

fixtures: ## Generate test fixtures
	$(COMPOSE) run --rm --profile tools test pnpm fixtures:generate

clean: ## Stop and remove volumes (destroys local data)
	$(COMPOSE) down -v
