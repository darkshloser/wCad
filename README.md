# wCAD — CAD/GIS Web Application

A browser-based CAD/GIS drawing platform built on [OpenLayers](https://openlayers.org/), designed from the start for **DXF/CAD drawings containing millions of objects**, 50–500 concurrent users, self-hosted on-premise deployment, and full-size local files that work entirely in the browser.

**Everything runs in Docker.** No host toolchain beyond Docker itself.

```bash
cp .env.example .env
make up          # web on http://localhost:5173
make test        # run the full test suite in a container
```

---

## Current status: Phase 1 complete

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, Docker stack, CI gates, fixture generator | **Done** |
| 1 | `geo-core` foundations + `GeometryStore` contract + conformance suite | **Done** — 115 tests passing |
| 2 | PostGIS schema, tile service, WebGL backdrop rendering | Schema in place; service pending |
| 3 | Streaming DXF/LandXML import pipeline | Pending |
| 4–9 | Editing, metadata, local mode, multi-user, export, hardening | Pending |

A **working demo app** ships with Phase 1: draw points, polylines, polygons, circles and true arcs; snap to existing vertices; enter coordinates by keyboard in AutoCAD syntax; right-click any element for its properties and a free-form JSON metadata editor. It runs on the in-memory reference store, so it works with no database at all.

See `docs/IMPLEMENTATION-PLAN.md` for the full phase-by-phase plan and `docs/CAD-GIS-Web-App-Architecture.md` for the architecture and the reasoning behind it.

---

## What Phase 1 actually delivers

Phase 1 is deliberately unglamorous: it is every decision that is cheap now and expensive to retrofit.

### `packages/geo-core`

| Module | What it does |
|---|---|
| `crs/` | CRS registry (WGS84, Web Mercator, UTM 35N, BGS2005/CCS2005, British National Grid) plus local/site systems with origin, rotation and scale |
| `precision/` | Float32 render-origin rebasing — the fix for GPU vertex jitter at large projected coordinates |
| `arc/` | True parametric arcs: sweep, endpoints, bounding box, three-point construction, DXF bulge conversion, adaptive tessellation, intersections |
| `simplify/` | Douglas–Peucker generalization and the LOD tolerance ladder, shared with the server |
| `commands/` | Client-side undo/redo command stack with transactions |
| `input/` | AutoCAD-style typed coordinate entry (`100,200`, `@10,5`, `@50<45`) |
| `layers/` | The backdrop / working-set split, enforced in the type system |

### `packages/store-contract`

One storage interface, a reference in-memory implementation, and a **runner-agnostic conformance suite**. The PostGIS store (Phase 2) and the SQLite-WASM/OPFS store (Phase 6) must pass that same suite unmodified — that is what makes "huge local file" and "huge server project" one feature rather than two products.

---

## Why some of this looks unusual

Three decisions in the code will look surprising unless you know the reasoning.

**Coordinates are compared with `Object.is`, not `toBeCloseTo`.**
In a CAD system, precision is a correctness property. A snapped vertex that is *nearly* the stored vertex is a tool nobody can trust. Storage round-trips and snapping assert bit-exact float64 equality.

**Tile geometry is structurally separate from editable geometry.**
Vector tiles quantize coordinates onto an integer grid — fine for pixels, fatal for CAD. The type system gives backdrop features no authoritative coordinates at all, `requireEditable()` throws if anything tries, and `dependency-cruiser` fails the build on an import from editing code into tile code.

**Coordinates are rebased before touching the GPU.**
Float32 has ~7 significant digits, so a UTM northing like `4650321.104` cannot be represented without losing centimetres. `rebase.test.ts` demonstrates the failure and proves the fix restores millimetre resolution across every registered CRS.

---

## Commands

All targets run inside containers:

```bash
make up          # start web, api, workers, PostGIS, Redis, MinIO
make down        # stop
make logs        # tail all services
make test        # full test suite
make typecheck   # project-wide TypeScript check
make depcruise   # architectural boundary enforcement (guardrail G1)
make psql        # psql into the database
make fixtures    # regenerate test fixtures
make clean       # stop and destroy volumes
```

Larger fixtures are generated on demand:

```bash
pnpm fixtures:generate --entities 500000   --out medium.dxf
pnpm fixtures:generate --entities 10000000 --out large.dxf   # ~1.4 GB, ~40 s
```

---

## Layout

```
apps/
  web/        React + OpenLayers SPA (the demo app)
  api/        API service — placeholder until Phase 2
  workers/    Python: DXF/LandXML/OGR import-export, LOD builds
packages/
  geo-core/       Shared CRS, arc, precision and generalization math
  store-contract/ GeometryStore interface, reference store, conformance suite
docker/       Dockerfiles, PostGIS init schema, nginx config
tools/        Fixture generator and verifier
fixtures/     Test data (large ones generated on demand)
docs/         Architecture and implementation plan
```

---

## Testing

115 tests currently pass across 8 files.

```
geo-core/arc                30 tests    sweep, bulge round-trip, tessellation, intersections
geo-core/crs                18 tests    proj4 round-trips, local systems, anchor coordinates
geo-core/coordinateInput    14 tests    typed entry parsing and resolution
geo-core/commands           11 tests    undo/redo, transactions, rollback
geo-core/simplify           11 tests    subsequence, determinism, monotonicity
geo-core/rebase              7 tests    float32 precision proofs
geo-core/layers              4 tests    backdrop/working-set separation
store-contract/memoryStore  20 tests    the conformance suite
```

Much of the suite is property-based (`fast-check`) rather than example-based, because the invariants are what matter: a round-trip must close, undoing everything must restore the original state, tessellation must stay within tolerance for *every* arc rather than the three someone happened to write down.

### Two findings worth knowing about

The tests already caught two real things during Phase 1:

- **EPSG:27700 does not round-trip to 0.1 mm.** OSGB36 reaches WGS84 through a 7-parameter Helmert transformation whose inverse proj4 solves iteratively, so closure is millimetre-level. That is a property of the datum, not a bug — and it is encoded explicitly in `crs.test.ts` because a CAD tool that pretends datum changes are lossless will eventually surprise a surveyor.
- **Negative zero cannot survive a text round-trip.** JavaScript renders `-0` as `"0"`. Geometrically irrelevant, but it is documented in `coordinateInput.test.ts` so nobody rediscovers it as a mystery.

---

## Notes

- A partial `node_modules/` directory may be present in the repository root and cannot be removed on this filesystem. It is gitignored and excluded by `.dockerignore`, so Docker builds and container-based tooling ignore it entirely. Delete it on your own machine if you prefer.
- `pnpm-lock.yaml` is generated on first install; commit it so `--frozen-lockfile` works in CI.
- **Open formats only.** DXF and LandXML for CAD/survey, OGR-backed formats for GIS. DWG is out of scope by design — no proprietary SDK, no per-seat licence, nothing that complicates an on-premise install.
