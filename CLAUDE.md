# CLAUDE.md

Guidance for Claude when working in this repository.

## Project

**wCAD** — a browser-based CAD/GIS application (OpenLayers client, PostGIS backend, Python import
workers), designed for millions of CAD objects and 50–500 users on-prem. License: AGPL-3.0-or-later.

## Specifications (read before changing related code)

| Topic | File |
|---|---|
| Selection, Pan tool, right-click menu, keyboard | [knowledge/selection-spec.md](knowledge/selection-spec.md) |
| Architecture and principles P1–P6, guardrails G1–G4 | [docs/CAD-GIS-Web-App-Architecture.md](docs/CAD-GIS-Web-App-Architecture.md) |
| Phases, exit criteria, budgets | [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) |

A spec in `knowledge/` is agreed with the product owner. If code and spec disagree, the code is
wrong unless the spec is updated first. Do not change agreed behaviour without asking.

## Layout

- `apps/web` — React + OpenLayers client. `src/map/engine.ts` owns the map; `src/map/toolRules.ts`
  holds DOM-free tool rules (unit-tested).
- `apps/tiles` — MVT tile service. `apps/api` — API (still a placeholder).
- `apps/workers` — Python import workers (PostgreSQL job queue, streaming DXF import).
- `packages/geo-core`, `store-contract`, `store-postgis`, `tiling` — shared libraries.
- `tools/` — fixtures, seed loader, benchmarks. `docker/` — images, schema and migrations.

## Commands (Windows PowerShell; everything runs in Docker)

```powershell
.\wcad.ps1 up            # start the stack, apply migrations
.\wcad.ps1 test          # unit/property/contract tests
.\wcad.ps1 typecheck
.\wcad.ps1 test-workers  # Python tests against PostGIS
.\wcad.ps1 e2e           # Playwright against the running stack
.\wcad.ps1 help          # everything else
```

The `Makefile` has the same targets for Linux/macOS.

## Conventions

- Every source file starts with the AGPL license header.
- No TypeScript parameter properties; use `#private` fields (tools run under
  `node --experimental-strip-types`).
- Authoritative geometry is float64 and travels as EWKB, never WKT (G2). The backdrop (tiles) is
  display-only and is never hit-tested or edited (P1).
- Keep non-DOM logic in pure modules with unit tests; cover interaction with Playwright specs in
  `apps/web/e2e`.
- Never report an unmeasured budget as passing.
