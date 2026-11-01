# wCAD — CAD/GIS Web Application

A browser-based CAD/GIS drawing platform built on [OpenLayers](https://openlayers.org/), designed from the start for **DXF/CAD drawings containing millions of objects**, 50–500 concurrent users, self-hosted on-premise deployment, and full-size local files that work entirely in the browser.

**Everything runs in Docker.** No host toolchain beyond Docker itself.

```bash
cp .env.example .env
make up          # web on http://localhost:5173
make test        # run the full test suite in a container
```

---

## Current status: Phase 3 in progress

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, Docker stack, CI gates, fixture generator | **Done** |
| 1 | `geo-core` foundations + `GeometryStore` contract + conformance suite | **Done** |
| 2 | PostGIS store, tile pyramid, tile service with cache tiers, tiled backdrop | **Done** — exit gate partly open, see below |
| 3 | Streaming DXF import pipeline | **Spine + block instancing done** — upload, LandXML/OGR/CSV pending |
| 4–9 | Editing, metadata, local mode, multi-user, export, hardening | Pending |

281 TypeScript tests and 122 Python tests pass (76 of the Python suites need a database and skip without one).

**Phase 2's exit gate is not fully closed.** Budgets are measurable and the tile path is verified,
but three criteria were deferred rather than met: visual regression baselines, the 1 mm-zoom
jitter test (the float32 guard), and the 500-VU k6 load test. They are tracked for Phase 9.

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

One storage interface, a reference in-memory implementation, and a **runner-agnostic conformance suite**. The PostGIS store passes it today; the SQLite-WASM/OPFS store (Phase 6) must pass the same suite unmodified — that is what makes "huge local file" and "huge server project" one feature rather than two products.

## What Phase 2 delivers

### `packages/tiling`

The tile pyramid, and the decision that shapes it: **tiles are cut in the project's own CRS, not Web Mercator.** Project data lives in a projected or local engineering CRS and is never reprojected at rest, so tiling in Web Mercator would put a datum transformation between a surveyor and their own coordinates. Nothing in the MVT specification requires it.

Covers the tile grid, zoom-to-LOD selection against a half-pixel error budget, small-feature culling, deterministic per-tile element caps, MVT quantization, and dirty-tile invalidation.

### `packages/store-postgis`

`PostgresStore` implements `GeometryStore` and passes the conformance suite against a real PostGIS container. Geometry crosses the wire as **EWKB binary, never WKT** — see below. Tile generation is `ST_AsMVT`, one protobuf layer per CAD layer, concatenated.

### `apps/tiles`

Standalone tile service with a three-tier cache: Valkey (hot) → filesystem (cold) → generate. Cold hits are promoted back into hot, so a restart warms itself under real traffic. Cache failures degrade to direct generation rather than taking the service down.

### Client

Tiled backdrop layer (`renderMode: 'hybrid'`) carrying the millions of objects, hit-testing filtered to the working set so a click can never select quantized tile geometry, and always-visible performance instrumentation in the status bar.

## What Phase 3 delivers so far

### The job queue lives in PostgreSQL

Not Redis, and not BullMQ as originally planned — BullMQ is Node-only while the import workers are
Python. The deciding argument is resumability: a stage checkpoint and the batch of rows it
describes commit in **one transaction**, so a worker killed mid-import cannot leave the queue
claiming progress the data does not reflect. With the queue in a separate process that becomes a
distributed-consensus problem. `SELECT ... FOR UPDATE SKIP LOCKED` handles concurrent claiming;
crashed workers are reclaimed by heartbeat expiry; exhausted retries dead-letter with their
checkpoint and error history intact for inspection.

### Nothing is lost silently

Every entity in a DXF is written, or counted **and named** in the job's report. The importer
refuses to report success unless

```
entities in the file == rows written + reported unsupported + reported failed
```

A drawing that imports at 94% while looking complete is corrupted data, and no amount of
spot-checking geometry finds it. `test_import_reconciliation.py` asserts this identity against
every fixture. One malformed entity is recorded and skipped rather than aborting a 10M-entity
import, and the error list is bounded while the counts stay exact.

### Generalization is bit-identical across two languages

The importer writes the `geom_lod1..3` columns with a Python port of Douglas-Peucker, while the
client generalizes the working set with the TypeScript original. If those disagree even slightly,
the backdrop and the working set draw the same geometry differently and the drawing appears to
shift as elements are selected. `fixtures/simplify-cases.json` is generated by the TypeScript
reference implementation, and `test_simplify_parity.py` asserts the Python output matches it
**exactly** — `==` on float64, not `isclose`.

### Blocks are instanced, not exploded (P5)

A site plan with 50,000 manhole symbols contains one manhole *drawing*, placed 50,000 times.
Storing each placement's exploded geometry multiplies the row count by the block's entity count —
and every one of those rows then has to be indexed, generalized, ranked and tiled.

Definitions are streamed from the DXF `BLOCKS` section and stored once as PostGIS geometry. Each
placement stores a `block_id` and a six-element affine transform, in PostGIS `ST_Affine` argument
order so nothing has to be reordered at read time. Instances are expanded **at tile time**, one
`ST_Affine` per instance, so exploded copies never exist at rest.

Two details that are easy to get wrong and invisible when you do. Scale is applied *before*
rotation — the other order shears any instance with unequal scales, which most drawings don't have,
so the bug hides. And an instance's bbox is computed from all four transformed corners, because a
rotated rectangle's extent is set by whichever corners end up furthest apart; the two-corner
shortcut understates it and instances vanish from tiles they belong in.

The Python transform is verified against PostGIS's own `ST_Affine` rather than a second Python
implementation — the database is what actually places the geometry.

### The fixtures were not valid DXF

Worth recording, because it went unnoticed for two phases. The fixture writer declared `AC1009`
(R12) while emitting `LWPOLYLINE` — an entity that did not exist until R14 — and omitted the `100`
subclass markers and handles that R2000+ requires. Our own lenient TypeScript parser read the
files happily, so everything looked correct; the first real DXF reader to touch them (`ezdxf`)
rejected them outright.

A fixture only your own code can read tests nothing about reading real files. The writer now emits
proper R2000 with handles, subclass markers and an `OBJECTS` section, and every fixture is verified
by loading it with `ezdxf` rather than with our own parser.

Coordinates go in as EWKB binary through `COPY`, so `precision.dxf` round-trips bit-for-bit (G2),
verified via `ST_AsEWKB` rather than text — `ST_AsText` would truncate to 15 significant digits and
hide exactly the loss the test guards against.

---

## Why some of this looks unusual

Three decisions in the code will look surprising unless you know the reasoning.

**Coordinates are compared with `Object.is`, not `toBeCloseTo`.**
In a CAD system, precision is a correctness property. A snapped vertex that is *nearly* the stored vertex is a tool nobody can trust. Storage round-trips and snapping assert bit-exact float64 equality.

**Tile geometry is structurally separate from editable geometry.**
Vector tiles quantize coordinates onto an integer grid — fine for pixels, fatal for CAD. The type system gives backdrop features no authoritative coordinates at all, `requireEditable()` throws if anything tries, and `dependency-cruiser` fails the build on an import from editing code into tile code.

**Coordinates are rebased before touching the GPU.**
Float32 has ~7 significant digits, so a UTM northing like `4650321.104` cannot be represented without losing centimetres. `rebase.test.ts` demonstrates the failure and proves the fix restores millimetre resolution across every registered CRS.

**Geometry goes to PostGIS as binary, not text.**
`ST_AsText` truncates to 15 significant digits by default, and `4650321.104567891` and `4650321.104567892` are distinct doubles that collapse to the same string. EWKB writes raw IEEE-754 bytes, so nothing can round. There is a test that demonstrates exactly this collapse.

---

## Windows / PowerShell

GNU Make is not installed on Windows by default, so every target is mirrored in a PowerShell
runner. Use `.\wcad.ps1 <task>` wherever this README says `make <task>`:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass   # once per terminal, if blocked
.\wcad.ps1 help
.\wcad.ps1 up
.\wcad.ps1 fixtures
.\wcad.ps1 seed -File fixtures\blocks.dxf
.\wcad.ps1 verify
```

It checks that Docker is actually running, creates `.env` from the example if missing, waits for
the tile service to become healthy before seeding or benchmarking, and prints the project URL
when it is done. If you would rather use `make`, install it with
`winget install ezwinports.make` or work inside WSL.

---

## Verifying Phase 2

Phase 2 is "done" when the budgets are **measured**, not when the code exists. This is the runbook.

```bash
cp .env.example .env
make up                              # PostGIS, Valkey, tiles, api, web, workers
make fixtures                        # tiny / small / blocks / precision / crs-points
make seed FILE=fixtures/blocks.dxf   # 100k entities, ~500 block definitions
make verify                          # unit -> integration -> health -> budgets
```

`make verify` runs four stages and stops at the first failure:

| Stage | What it proves |
|---|---|
| Unit, property, contract | The maths and the store contract hold. No Docker beyond the runner |
| Integration | `PostgresStore` passes the **identical** conformance suite as the in-memory store, against real PostGIS (guardrail G3), and tiles are byte-identical across regenerations |
| Health | The tile service is up and can reach the database |
| Budgets | Real tile latency and cache hit rate against the architecture document's numbers |

`make bench` alone prints something like:

```
project 1 "seed:fixtures/blocks.dxf"
  CRS       EPSG:32635
  elements  100,000
  z0 tile   16800.0 CRS units

  z3   16 tiles  4.10 m/px   cold p95  118 ms   warm p95   4 ms
  z5   36 tiles  1.02 m/px   cold p95   64 ms   warm p95   3 ms
  ...

budgets
  PASS  Tile generate (cache miss) p95     118.0 ms  (budget <= 300 ms)
  PASS  Tile serve (cache hit) p95           4.0 ms  (budget <= 20 ms)
  PASS  Cache hit rate                      96.4 %   (budget >= 90 %)
```

**A pass on `blocks.dxf` is not the exit gate.** The budgets are defined at 10M elements, and the
bench says so explicitly when the project is smaller. The real gate is:

```bash
make fixture-large                    # 10M entities, ~1.4 GB
make seed FILE=fixtures/large.dxf     # several minutes
make bench
make e2e                              # Playwright: fps, hover cost, heap
```

`make e2e` measures the client half — sustained frame rate through pan and zoom, that hover
performs **zero** network requests (principle P3), and heap against the 1.5 GB budget. Headless
Chromium runs on SwiftShader, so its frame rates are pessimistic and the thresholds are loosened;
treat a failure as "measure this on real hardware", not as a blocker. The numbers are always
printed.

### The decision this measurement drives

Per §14 of the implementation plan, the end of Phase 2 is a checkpoint, not just a milestone: it
is where you find out with real data whether OpenLayers' renderers reach the frame budget at 10M
elements, or whether the custom WebGL renderer escape hatch (§5.1 of the architecture) is needed.
Making that call now is cheap — the backdrop is one module behind a stable interface. Making it
after Phase 4 is not.

---

## Commands

All targets run inside containers.

```bash
make up            # start the stack
make down          # stop
make ps            # service status
make logs          # tail all services

make test          # unit, property and contract tests
make test-integration  # Testcontainers suites against real PostGIS
make test-workers  # Python worker suites against real PostGIS
make e2e           # Playwright render-budget tests
make typecheck     # project-wide TypeScript check
make depcruise     # architectural boundary enforcement (guardrail G1)

make fixtures      # standard fixture set
make fixture-large # 10M-entity fixture (~1.4 GB)
make import FILE=... # import a DXF through the real pipeline
make import-bench  # Phase 3 exit gate: 10M entities against the import budgets
make migrate       # apply pending schema migrations (run automatically by `up`)
make migrate-status # which migrations are applied
make seed FILE=... # bulk-load a fixture for benchmarking only (lossy, see below)
make flush-tiles   # clear both cache tiers — required before a meaningful bench
make bench         # tile budgets, pass/fail
make verify        # the whole Phase 2 gate

make projects      # what the tile service can see
make tile-metrics  # cache counters
make psql          # psql into the database
make valkey        # valkey-cli
make clean         # stop and destroy volumes
```

The web app discovers its project from the tile service, so after importing just reload
`http://localhost:5173`. To pin a specific one, use `http://localhost:5173/?project=<id>` — both
`import` and `seed` print the URL.

**`import` and `seed` are not the same thing.** `import` is the production path: it queues a job,
streams the file, writes EWKB so coordinates stay bit-exact, reconciles the entity counts, and
records the project extent. `seed` is a benchmark loader that writes WKT — faster to build in
bulk, and *lossy at the 15th significant digit*. It exists to put 10M synthetic rows in front of
the tile service quickly and is documented as never for real data. Use `import` for anything you
care about.

On Windows every command above is `.\wcad.ps1 <task>`, with `-File` instead of `FILE=`:

```powershell
.\wcad.ps1 import -File fixtures\small.dxf
.\wcad.ps1 test-workers
```

---

## Layout

```
apps/
  web/        React + OpenLayers SPA (the demo app)
  api/        API service — placeholder until Phase 4
  tiles/      Tile service: ST_AsMVT generation with a three-tier cache
  workers/    Python: DXF/LandXML/OGR import-export, LOD builds
packages/
  geo-core/       Shared CRS, arc, precision and generalization math
  store-contract/ GeometryStore interface, reference store, conformance suite
  tiling/         Tile pyramid, LOD selection, ranking, quantization, invalidation
  store-postgis/  PostGIS implementation, EWKB codec, ST_AsMVT tile SQL
docker/       Dockerfiles, PostGIS init schema, nginx config
tools/
  fixtures/   Fixture generator and verifier
  seed/       Streaming bulk loader into PostGIS
  bench/      Tile service benchmark, asserts the budgets
fixtures/     Test data (large ones generated on demand)
docs/         Architecture and implementation plan
```

---

## Testing

260 tests currently pass across 20 files, plus Testcontainers integration suites that need Docker.

```
geo-core/arc                  30    sweep, bulge round-trip, tessellation, intersections
tiling/scheme                 20    grid coverage, no gaps or duplicates, pyramid nesting
store-contract/memoryStore    20    the conformance suite
geo-core/crs                  18    proj4 round-trips, local systems, anchor coordinates
store-postgis/geometryMapping 17    kind mapping, ring closing, LOD parity
store-postgis/tileQuery       15    SQL shape, parameterization, determinism
geo-core/coordinateInput      14    typed entry parsing and resolution
store-postgis/wkb             14    bit-exact float64 round-trip
tools/seed/dxfParse           14    streaming DXF tokenizer
apps/tiles/cache              13    tier promotion, invalidation, failure degradation
tiling/lod                    12    error budget, monotonicity, culling
geo-core/commands             11    undo/redo, transactions, rollback
geo-core/simplify             11    subsequence, determinism, monotonicity
apps/web/instrumentation      11    percentiles, sample bounds
tiling/ranking                 9    deterministic total order under shuffling
tiling/invalidation            9    old and new footprints, overflow handling
geo-core/rebase                7    float32 precision proofs
tiling/quantize                7    lossiness bounds
geo-core/layers                4    backdrop/working-set separation
apps/tiles/keyParsing          4    cache key round-trip
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
