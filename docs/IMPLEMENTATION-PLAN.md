# CAD/GIS Web Application — Implementation Plan & Test Strategy

Companion to `CAD-GIS-Web-App-Architecture.md` (v2). That document says *what* to build and why; this one says *in what order*, *how to know each part works*, and *what must be true before moving on*.

Section references like §4.1 point into the architecture document. Principle references (P1–P6) are its design principles.

---

## 0. How to Use This Plan

Ten phases. Each has a **goal**, numbered **steps**, a **test suite**, and **exit criteria** that must all pass before the next phase starts. Phases deliberately produce something demonstrable — you should never be more than a few weeks from seeing real drawings on screen.

Two rules that make the difference between this plan working and not:

1. **Phase 1 is not optional and cannot be deferred.** It is unglamorous foundation work with nothing visible at the end. Every expensive-to-retrofit decision lives there.
2. **A phase is done when its tests pass, not when the code exists.** Tests here aren't a quality ritual — in a CAD system, a silent precision bug can corrupt a customer's survey data months before anyone notices. The test suite is the only thing standing between you and that.

---

## 1. Testing Philosophy

### 1.1 What matters in *this* domain

Ordinary web-app testing wisdom under-weights three things that dominate here:

- **Precision is a correctness property, not a quality-of-implementation detail.** "Close enough" is a bug. Many tests below assert *bit-exact* float64 equality rather than approximate equality, and that is intentional.
- **Scale must be tested with scale.** A pipeline that works on 1,000 entities tells you almost nothing about 10,000,000. Large fixtures are part of the test suite, not an afterthought.
- **Two implementations of the same contract must be provably interchangeable** (P4). This is what the conformance suite exists for.

### 1.2 Test levels

| Level | Scope | Speed | When it runs |
|---|---|---|---|
| **Unit** | Pure functions: CRS math, arc math, generalization, rebasing, tessellation | ms | Every save, every commit |
| **Property-based** | Invariants over randomly generated inputs (round-trips, idempotence) | s | Every commit |
| **Contract / conformance** | `GeometryStore` suite, run identically against local and remote implementations | s–min | Every commit |
| **Integration** | Real PostGIS + Redis via Testcontainers; real SQLite-WASM in a real browser | min | Every commit |
| **End-to-end** | Playwright, real browser, real stack, real fixtures | min | Every PR |
| **Visual regression** | Screenshot diffs of rendered drawings | min | Every PR |
| **Performance / budget** | The §1 budgets asserted as pass/fail | min–h | Nightly + before release |
| **Load** | k6, 500 virtual users | h | Weekly + before release |
| **Chaos** | Kill workers/DB mid-operation, assert recovery | h | Weekly |

### 1.3 Tooling

| Concern | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Shared packages between web/api/tiles with caching |
| TS unit tests | **Vitest** | Fast, ESM-native, same config as the Vite web build |
| Property-based | **fast-check** (TS), **Hypothesis** (Python) | Finds the edge cases you wouldn't think of |
| API integration | Vitest + **Testcontainers** (real PostGIS, Redis) | Mocking a spatial database tests nothing real |
| DB access | **Kysely** + raw SQL for spatial | Typed queries, no ORM fighting PostGIS |
| Migrations | **node-pg-migrate**, forward-only, every migration reversible-tested | |
| Python workers | **pytest** + pytest-benchmark + Hypothesis | |
| E2E | **Playwright** | Real Chromium/Firefox/WebKit; needed anyway for OPFS + WebGL |
| Visual regression | Playwright screenshots + **pixelmatch** | |
| Load | **k6** | Scriptable, good percentile reporting |
| Architecture rules | **dependency-cruiser** | Mechanically enforces P1/P4 boundaries |
| Coverage | Vitest c8 / coverage.py | |
| Mutation testing | **Stryker** on `geo-core` only | Worth it for pure math; not worth it elsewhere |

### 1.4 Coverage targets (enforced in CI)

| Package | Line | Branch | Rationale |
|---|---|---|---|
| `geo-core` | 95% | 90% | Pure math, cheap to test, catastrophic if wrong |
| `store-contract` + implementations | 90% | 85% | The interchangeability guarantee |
| `api` | 80% | 75% | |
| `workers` | 85% | 80% | Import correctness is data-integrity critical |
| `web` (logic, excluding rendering) | 70% | 65% | |
| Rendering code | not measured | — | Covered by visual + performance tests instead |

### 1.5 Definition of Done — applies to every task in every phase

A task is complete only when **all** of these hold:

- [ ] Unit tests for new logic, including at least one failure/edge case
- [ ] Property-based test where an invariant exists (round-trip, idempotence, ordering)
- [ ] Integration test if it crosses a process or storage boundary
- [ ] Performance test if it's on a hot path (rendering, tiles, snapping, import)
- [ ] Coverage thresholds still met
- [ ] `dependency-cruiser` rules pass (no architectural boundary violations)
- [ ] Docs updated if behaviour or a contract changed
- [ ] No new lint/type errors; CI green
- [ ] Manually exercised against the **medium** fixture at minimum

### 1.6 CI gates

**Every commit** (target < 10 min): lint, typecheck, unit, property, contract, integration on tiny + small fixtures, dependency-cruiser, coverage.

**Every PR** (target < 30 min): the above, plus E2E, visual regression, and integration on the medium fixture.

**Nightly**: full performance budget suite on the large fixture, memory profiling, mutation tests on `geo-core`.

**Weekly**: load tests, chaos tests, full import/export round-trips on all fixtures.

**Release**: everything, plus a manual exploratory pass and a backup/restore drill.

---

## 2. Test Fixtures and Data Strategy

Fixtures are infrastructure. Build the generator in Phase 0 — retrofitting realistic large test data later is painful and you'll be tempted to skip the tests that need it.

| Fixture | Size | Purpose |
|---|---|---|
| `tiny.dxf` | ~50 entities | Hand-written, contains **one of every supported entity type**. Human-readable, diffable, used in unit tests |
| `small.dxf` | 10k | Fast integration tests, runs on every commit |
| `medium.dxf` | 500k | PR-level tests; the smallest size where scale problems start showing |
| `large.dxf` | 10M | Nightly performance budgets. Generated, not stored in git |
| `blocks.dxf` | 100k instances / 500 definitions | Exercises P5 instancing specifically |
| `pathological.dxf` | ~1k | Zero-length lines, duplicate vertices, self-intersecting polygons, degenerate arcs (r=0, start=end), NaN coordinates, coordinates near float64 limits, empty layers, cyclic block references, mixed line endings, truncated file |
| `precision.dxf` | ~100 | Coordinates with full 15–17 significant digits, large projected values (e.g. N 4650321.123456789), used exclusively for precision round-trip assertions |
| `crs-points.json` | 10k points × N systems | Reference coordinates with known-correct transforms, used to verify TS and Python agree |
| `landxml-survey.xml` | ~50k | Survey points, TIN surface, alignment |
| Real customer files | varies | Anonymized, kept out of git (LFS or a fixtures server). **Nothing substitutes for real files** — real DXFs are always stranger than generated ones |

```bash
pnpm fixtures:generate --type dxf --entities 10000000 --blocks 50000 --out large.dxf
pnpm fixtures:verify        # checksums + entity counts, so fixtures can't silently drift
```

The generator must produce *realistic* distributions — clustered geometry, mixed entity types, uneven layer sizes, varied polyline lengths. Uniformly random geometry is unrealistically easy on spatial indexes and will give you falsely optimistic benchmarks.

---

## 3. Architectural Guardrails Enforced by Tests

Four rules from the architecture are mechanically enforced, because they're the ones that erode silently under deadline pressure:

**G1 — No editing path may import tile/display code (P1).**
`dependency-cruiser` forbids any module under `editing/`, `snapping/`, or `measurement/` from importing `tiles/` or MVT decoding. A build-breaking rule, not a convention.

**G2 — Coordinates survive storage bit-exactly.**
A dedicated suite writes `precision.dxf` coordinates through every store and asserts `Object.is(read, written)` — exact float64 equality, not `toBeCloseTo`.

**G3 — Both stores pass the identical conformance suite (P4).**
`store-contract` exports a suite parameterized by store factory. Adding a store implementation without wiring it into the suite fails CI.

**G4 — Performance budgets are assertions.**
§1's budgets are executable tests that fail the nightly build. A budget regression is a bug with a broken test, not a "nice to look into someday".

---

## 4. Phase 0 — Foundations of the Foundation

**Goal:** a repository where writing a well-tested change is the path of least resistance. ~1–2 weeks.

### Steps

1. Initialize pnpm workspace monorepo with the §12 layout; TypeScript strict mode everywhere (`strict: true`, `noUncheckedIndexedAccess: true`).
2. Configure Vitest, ESLint, Prettier, and dependency-cruiser with the G1 ruleset stubbed in from day one.
3. Set up CI (GitHub Actions / GitLab CI / self-hosted runner) with the §1.6 gate structure — even though most suites are empty, so gates exist before there's pressure to skip them.
4. `docker compose` dev environment: PostgreSQL + PostGIS, Redis, MinIO. One command to a working stack.
5. Testcontainers harness: a helper that spins a real PostGIS instance per integration test file with migrations applied.
6. Build the **fixture generator** and produce tiny/small/medium; verify large generates within a sane time.
7. Playwright configured against a placeholder page, proving browser tests run in CI (WebGL and OPFS in headless CI are a known source of friction — find out now, not in Phase 6).
8. Coverage reporting and thresholds wired up and failing correctly when thresholds are unmet.

### Tests

| Level | What |
|---|---|
| Meta | CI fails when a deliberately broken test is introduced (verify the gates actually gate) |
| Meta | Coverage threshold failure is detected |
| Meta | dependency-cruiser rejects a deliberate boundary violation |
| Integration | Testcontainers spins PostGIS, migrations apply, teardown is clean |
| E2E | Playwright loads a page and captures a WebGL canvas screenshot in headless CI |

### Exit criteria

- [ ] `pnpm test` runs green in under 60 s on an empty codebase
- [ ] CI pipeline green, all gates demonstrably functional
- [ ] `docker compose up` yields a working stack from a clean machine
- [ ] Fixtures generate reproducibly; `fixtures:verify` passes
- [ ] Playwright captures a WebGL screenshot in headless CI

---

## 5. Phase 1 — Core Foundations (`geo-core`, store contract)

**Goal:** every piece of math and every interface that is expensive to change later. Nothing user-visible. ~4–6 weeks.

> This is the phase people skip. Don't. The layer split, the store contract, and float32 rebasing each cost days now and months later.

### Steps

1. **CRS registry** (`geo-core/crs`): CRS definition type (code, proj4 string, units, axis labels/order, valid extent, render origin). Loader, `proj4.defs()` registration, OpenLayers `register()` binding.
2. **Local CRS support**: origin + rotation + scale, forward/inverse transforms to a base CRS.
3. **Python registry generation**: a build step emitting the Python-side registry from the same source of truth, so TS and workers can never drift (§9).
4. **Coordinate rebasing** (`geo-core/precision`): float64 → render-origin-relative → float32, with origin selection/re-selection policy (§5.2).
5. **Arc math** (`geo-core/arc`): parametric arc type; bulge ↔ arc conversion; adaptive tessellation with sagitta-based segment count; arc↔arc and arc↔line intersection.
6. **Generalization** (`geo-core/simplify`): Douglas–Peucker with the LOD tolerance ladder; must be identical in TS and Python (or Python defers to a shared definition) so client and server LOD agree.
7. **`GeometryStore` contract** (`store-contract`): the interface from §7, plus the parameterized conformance suite, plus an in-memory reference implementation used to validate that the suite itself is correct.
8. **Layer-split abstraction** (`geo-core/layers`): `BackdropSource` and `WorkingSetSource` as distinct types with distinct capabilities — the working set can be edited, the backdrop structurally cannot. Enforced by types, not discipline.
9. **Command/undo stack** (`geo-core/commands`): command + inverse pattern, transactional grouping.
10. Wire G1 dependency-cruiser rules against the now-real module boundaries.

### Tests

| Level | What | Notes |
|---|---|---|
| Property | CRS round-trip: `inverse(forward(p)) ≈ p` within 1 mm for random points in each CRS's valid extent | fast-check, all registered CRS |
| Cross-impl | TS proj4 vs Python pyproj agree within 1 mm on `crs-points.json` | **The test that prevents the worst class of bug in this system** |
| Property | Local CRS round-trip across random origins/rotations/scales | |
| Unit | Rebasing: for the full valid extent of each CRS, rebased float32 values retain ≥ 1 mm resolution | Directly asserts the §5.2 fix works |
| Property | Bulge ↔ arc round-trip is lossless within float64 tolerance | |
| Property | Arc tessellation: first/last tessellated points equal exact arc endpoints; max sagitta deviation ≤ tolerance; segment count grows monotonically with radius | |
| Golden | Arc tessellation output for a fixed set of arcs, byte-compared | Catches unintended changes |
| Property | Generalization: output is a subsequence of input; endpoints always preserved; tolerance 0 is identity |
| Cross-impl | TS and Python generalization produce identical output on the same input | Client/server LOD must match |
| Contract | Conformance suite passes against the in-memory reference store | |
| Property | Undo stack: any random sequence of commands, fully undone, returns deep-equal initial state | |
| Unit | Degenerate arcs (r=0, start=end, full circle), zero-length segments, NaN inputs are rejected with clear errors | From `pathological.dxf` |
| Meta | dependency-cruiser rejects a backdrop→editing import | G1 |

### Exit criteria

- [ ] `geo-core` coverage ≥ 95% line / 90% branch; Stryker mutation score ≥ 80%
- [ ] TS↔Python parity tests pass for both CRS transforms and generalization
- [ ] Conformance suite passes against the reference store
- [ ] Rebasing proven to preserve ≥ 1 mm precision across every registered CRS extent
- [ ] G1 rules active and enforcing

---

## 6. Phase 2 — Server Read Path and Backdrop Rendering

**Goal:** open a pre-loaded 10M-object drawing and pan/zoom it at 60 fps. The first genuinely impressive milestone. ~6–8 weeks.

### Steps

1. **Schema and migrations** (§4.2): partitioned `elements`, LOD columns, GiST and GIN indexes, `block_definitions`, `styles`, `dirty_tiles`. Include a partition-management routine.
2. **Seed path**: a direct bulk loader (bypassing the not-yet-built import pipeline) so fixtures can be pushed into PostGIS for testing.
3. **Tile service**: `/tiles/:project/:z/:x/:y.mvt` — zoom→LOD selection, per-CAD-layer MVT layers, per-tile element caps with deterministic importance ordering, `ST_AsMVT` aggregation.
4. **Cache tiers**: Redis hot cache → MinIO/filesystem cold cache → generate. nginx configured to serve cached tiles without touching Node.
5. **Dirty-tile invalidation**: write path marks tiles dirty across zooms; lazy eviction and rebuild.
6. **Read replicas + PgBouncer** in the compose/Helm setup.
7. **Client backdrop layer**: OpenLayers `VectorTile` layer, `renderMode: 'hybrid'`, consuming the tile endpoint, with client-side layer visibility toggling.
8. **Client working-set layer**: `WebGLVectorLayer` with bbox loading strategy and rebased coordinate upload (not yet editable — read-only in this phase).
9. **Client RBush index** over the working set for hit-testing.
10. **Instrumentation**: fps meter, tile timing, heap sampling — needed by the budget tests, and useful forever.

### Tests

| Level | What |
|---|---|
| Integration | Tile endpoint returns valid MVT; decodes to the expected feature count per layer |
| Integration | Zoom→LOD selection picks the correct geometry column at each zoom |
| Integration | Tile generation is **deterministic** — same inputs produce byte-identical output (cache correctness depends on this) |
| Integration | Per-tile element caps hold on the densest region of `large.dxf`; ordering is stable across runs |
| Integration | Cache tiers: miss→generate→Redis→MinIO promotion; hit returns identical bytes |
| Integration | Invalidation marks exactly the affected tiles dirty across all zooms — and provably **does not** evict unaffected tiles |
| Property | Every element in a bbox appears in exactly one tile at a given zoom (no gaps, no duplicates at tile boundaries) |
| Integration | Layer visibility toggling never triggers tile regeneration |
| E2E | Load `large.dxf`, pan and zoom through a scripted path, no rendering errors, no console errors |
| Visual | Screenshot diffs at fixed extents across all fixtures; < 0.1% pixel difference tolerance |
| Visual | Zoom to 1 mm scale at large projected coordinates, pan slightly — **assert no vertex jitter** (the float32 regression test) |
| Perf | First meaningful paint of `large.dxf` < 2 s |
| Perf | Sustained fps ≥ 60 (min ≥ 30) over a scripted pan/zoom sequence |
| Perf | Tile cache hit < 20 ms; cache miss < 300 ms (p95) |
| Perf | Client heap < 1.5 GB with `large.dxf` loaded |
| Load | k6, 500 VUs panning: p95 tile latency within budget, cache hit rate > 90% |

### Exit criteria

- [ ] All §1 rendering and tile budgets pass on `large.dxf`
- [ ] Visual regression baseline established for every fixture
- [ ] No jitter at 1 mm zoom in a large-coordinate CRS
- [ ] Load test passes at 500 VUs
- [ ] Backdrop and working-set layers are separate code paths (G1 enforced)

---

## 7. Phase 3 — Import Pipeline

**Goal:** load real customer DXF and LandXML files, at full size, reliably, with progress. ~5–7 weeks.

### Steps

1. **Job infrastructure**: BullMQ queues, worker pool, resumable stage checkpointing, progress events over WebSocket, dead-letter handling.
2. **Upload**: chunked/resumable upload to MinIO with server-side checksum verification.
3. **Streaming DXF parser**: `ezdxf.iterdxf`, entity-by-entity, never loading the document (§8.2).
4. **Entity mapping**: DXF entity types → internal `kind`, with an explicit registry. Unsupported entities are **counted and reported**, never silently dropped.
5. **Block handling (P5)**: block definitions extracted once, instances stored as reference + affine transform.
6. **Bulk load**: batched `COPY` into PostGIS, ~10k rows per batch, inside checkpointed transactions.
7. **LOD pyramid build** as a subsequent job stage.
8. **Initial tile warming** for the project's home extent.
9. **LandXML importer** via `lxml.iterparse`: survey points, TIN surfaces, alignments, parcels.
10. **GDAL/OGR importer** for GeoPackage, Shapefile, GeoJSON, KML.
11. **CSV/TXT point importer** with configurable column mapping.
12. **CRS assignment UI**: detect where declared, prompt where ambiguous, never guess silently.

### Tests

| Level | What |
|---|---|
| Unit | Each DXF entity type maps correctly — driven by `tiny.dxf`, which contains one of each |
| **Reconciliation** | For every fixture: `entities_in_file == rows_in_db + reported_unsupported`. **Zero silent loss.** Run for all fixtures including real customer files |
| Integration | Blocks import as definitions + instances; instance count and resolved geometry match an exploded reference import |
| Precision | `precision.dxf` round-trips bit-exactly into the database (G2) |
| Integration | `pathological.dxf` imports without crashing; every malformed entity appears in the error report with a usable message |
| Chaos | Kill the worker at 20%, 50%, 80% — on restart the final database state is identical to an uninterrupted import |
| Chaos | Kill PostgreSQL mid-batch — no partial/torn batches survive |
| Integration | Duplicate import of the same file is idempotent or cleanly rejected (decide and test the chosen behaviour) |
| Integration | LandXML: survey points, TIN, and alignments import with correct geometry and attributes |
| Integration | OGR formats import with CRS correctly assigned |
| Property | CSV importer handles arbitrary column orders, delimiters, and decimal separators |
| Perf | `large.dxf` (10M entities) imports in < 15 min; memory stays flat (proving streaming — a memory graph that climbs means something is buffering) |
| Perf | LOD pyramid build for 10M entities within the job budget |
| E2E | Upload → progress updates → project becomes viewable, through the real UI |

### Exit criteria

- [ ] Reconciliation passes on every fixture *and* on real customer files
- [ ] 10M-entity import within budget with flat memory
- [ ] Resumability proven by chaos tests at three interruption points
- [ ] Unsupported-entity reporting is complete and human-readable
- [ ] Precision round-trip bit-exact

---

## 8. Phase 4 — Drawing and Editing

**Goal:** actually draw and edit, with CAD precision, on a 10M-object drawing. ~6–8 weeks.

### Steps

1. **Exact-geometry API** (§6.1) and client promotion of elements from backdrop into the working set.
2. **Snap-candidate API** (§6.2), capped and proximity-ordered.
3. **Client snap index**: RBush over candidates, refreshed on view change, feeding a bounded `Collection` to `ol/interaction/Snap`.
4. **Snap modes**: endpoint, vertex, midpoint, center, intersection, perpendicular, tangent, nearest — plus grid and orthogonal/angle-lock computed analytically.
5. **Draw tools**: point, line, polyline, polygon, rectangle, circle, arc (three-point, center-start-end, start-end-radius).
6. **`ArcGeometry`**: custom OL geometry backed by `geo-core/arc`, with the per-zoom tessellation cache.
7. **Typed coordinate entry**: command-line input parsing absolute `X,Y,Z` / `N,E,H`, relative `@dx,dy`, polar `@len<angle` — feeding the *same* geometry builder as mouse input.
8. **Modify/transform tools**: move, copy, rotate, scale, mirror, trim, extend, offset, fillet (JSTS-backed where useful).
9. **Undo/redo** wired to the Phase 1 command stack.
10. **Commit path**: batched per user action, optimistic version check, dirty-tile marking.

### Tests

| Level | What |
|---|---|
| **Precision** | A snapped coordinate is **bit-exactly equal** to the stored vertex — `Object.is`, not approximate. This is the single most important test in the phase |
| Precision | Drawn coordinates round-trip through commit and reload bit-exactly (G2) |
| Property | Typed entry and equivalent mouse input produce identical geometry |
| Property | Relative/polar coordinate parsing: `parse(format(p)) === p` for random inputs |
| Unit | Every snap mode returns the geometrically correct point, including degenerate cases (tangent to a zero-radius arc, parallel-line intersection) |
| Integration | Snap candidate set stays bounded on `large.dxf` regardless of local density |
| Perf | Snap resolution < 16 ms at the densest point of `large.dxf` |
| Perf | Hover → highlight < 16 ms, with zero network requests (assert via network interception) |
| Property | Undo any random operation sequence → state deep-equals the initial state |
| Property | Transform operations compose correctly: `rotate(90)×4 == identity` within tolerance; `move(d)+move(-d) == identity` bit-exactly |
| Integration | Arc drawn by each of the three construction methods yields the same arc given equivalent inputs |
| Integration | Commit marks the correct tiles dirty; backdrop reflects the edit after refresh |
| E2E | Draw a polyline snapping to existing vertices, modify it, undo, redo, save, reload — geometry identical |
| Visual | Rubber-band preview, snap indicators, and selection highlighting render correctly |
| Meta | G1: no editing module imports tile code |

### Exit criteria

- [ ] Bit-exact snapping proven by test
- [ ] All interaction budgets met on `large.dxf`
- [ ] Undo/redo property tests pass over long random sequences
- [ ] Every snap mode has a correctness test including degenerate cases

---

## 9. Phase 5 — Properties and Metadata

**Goal:** right-click any element, see and edit its properties and free-form JSON metadata. ~2–3 weeks.

### Steps

1. Context menu via DOM `contextmenu` + `forEachFeatureAtPixel` against the RBush index.
2. Properties panel: geometry properties in CRS-correct axis labels, layer, style, computed values (length, area, radius).
3. **Lazy metadata fetch** — only when the panel opens (§10).
4. JSONB metadata editor (Monaco for raw JSON, optional `@rjsf` schema-driven form where a layer defines a schema).
5. Optional per-layer JSON Schema validation.
6. Metadata search API using GIN-indexed JSONB containment queries.

### Tests

| Level | What |
|---|---|
| Integration | **Metadata is not present in any render-path response** — assert its absence, since accidental inclusion silently destroys bandwidth at scale |
| Property | Arbitrary nested JSON round-trips through JSONB unchanged, including unicode, deep nesting, large arrays, and numeric edge values |
| Integration | Metadata search returns correct results and uses the GIN index (assert via `EXPLAIN`) |
| Unit | Computed properties (length, area, arc radius) correct in each CRS, including local CRS with scale factor |
| Unit | Axis labels follow the active CRS (X/Y/Z vs N/E/H vs Lon/Lat) |
| Integration | Schema validation rejects invalid metadata with actionable messages |
| E2E | Right-click → properties → edit metadata → save → reload → persisted |
| Perf | Panel opens in < 100 ms on `large.dxf` |
| Perf | Metadata search over 10M elements returns p95 < 500 ms |

### Exit criteria

- [ ] Metadata provably absent from render responses
- [ ] Arbitrary JSON round-trip verified by property tests
- [ ] Search uses the index, within budget

---

## 10. Phase 6 — Local File Mode at Full Scale

**Goal:** open a multi-million-object DXF entirely in the browser, with identical behaviour to server mode. ~6–8 weeks.

### Steps

1. **SQLite WASM on OPFS** in a dedicated Web Worker; schema mirroring the server's, R\*Tree virtual table for spatial indexing.
2. **`LocalStore`** implementing `GeometryStore` — same contract, same semantics (P4).
3. **Streaming client-side DXF tokenizer** in a Worker: incremental group-code/value line-pair parsing, never materializing the file.
4. **Batched insertion** into SQLite with progress reporting.
5. **Local LOD pyramid generation** using the *shared* generalization code, so local and server LOD match exactly.
6. **Local MVT generation** for the backdrop (or an equivalent client-side backdrop path).
7. **File System Access API** integration with a fallback for browsers lacking it.
8. **Persistence management**: request persistent storage, surface quota usage, handle eviction gracefully, allow re-indexing.
9. **"Publish to server project"**: stream a local database through the server import pipeline.

### Tests

| Level | What |
|---|---|
| **Contract** | `LocalStore` passes the *identical* conformance suite as `RemoteStore` (G3) — the central test of this phase |
| Cross-impl | Same fixture imported locally and server-side produces identical query results for tiles, exact geometry, and snap candidates |
| Cross-impl | Local and server LOD generalization produce identical output |
| Precision | `precision.dxf` round-trips bit-exactly through SQLite WASM (G2) |
| Integration | OPFS database persists across page reload and browser restart |
| Integration | Reopening an already-indexed file skips indexing entirely |
| Chaos | Tab closed mid-indexing → clean recovery on reopen (resume or restart cleanly, no corrupt state) |
| Chaos | OPFS eviction simulated → graceful re-index with clear user messaging, no data loss of unsaved edits |
| Perf | 2 GB DXF indexes in < 3 min; subsequent opens are instant |
| Perf | Memory stays flat during indexing (proving streaming) |
| Perf | Post-index interaction budgets match server mode |
| E2E | Full offline workflow: open, draw, edit, save, reload — with the network fully disabled |
| E2E | Publish-to-server produces a project identical to a direct server import of the same file |
| Compat | Runs on Chromium, Firefox, WebKit — with documented behaviour where OPFS support differs |

### Exit criteria

- [ ] `LocalStore` passes the full conformance suite unmodified
- [ ] Local and server modes produce identical results on identical input
- [ ] 2 GB local file within indexing budget, flat memory
- [ ] Complete offline workflow verified with the network disabled
- [ ] Eviction and interruption handled without data loss

---

## 11. Phase 7 — Multi-User and Collaboration

**Goal:** 50–500 users working on shared projects safely. ~4–6 weeks.

### Steps

1. Auth (JWT/OIDC), users, project membership, layer-level rights (view/edit/admin).
2. Authorization enforced at the data layer, not just the route layer.
3. Optimistic-concurrency commits with conflict responses and client-side resolution UX.
4. Per-project WebSocket rooms with a Redis pub/sub backplane across API replicas.
5. Confirmed-edit broadcast and client-side application of remote changes.
6. Soft advisory locks in Redis (short TTL, broadcast to the room).
7. Optional throttled presence (~10 Hz, never persisted, droppable under load).
8. `element_history` audit log with retention and roll-up.

### Tests

| Level | What |
|---|---|
| Integration | **Two clients edit the same element from the same base version → second receives a conflict; neither client's data is lost** |
| Property | Concurrent commits from N clients to distinct elements all succeed; version numbers are monotonic with no gaps |
| Integration | Authorization: every endpoint rejects unauthorized access at the data layer (test with a direct service-layer call, bypassing routes) |
| Integration | A user without layer rights cannot read or modify that layer's elements via *any* path — including tiles |
| Integration | WS broadcast reaches all room members across multiple API replicas |
| Integration | Room isolation: project A's edits never reach project B's subscribers |
| Chaos | API replica killed mid-session → clients reconnect and resynchronize without losing local edits |
| Chaos | Redis restarted → locks expire safely; correctness preserved (locks are UX, versions are truth) |
| Integration | Soft lock expiry doesn't corrupt state when a client vanishes |
| Perf | Commit round trip < 200 ms at 500 concurrent users |
| Load | k6: 500 VUs, mixed read/edit workload, sustained 1 h — latency and error budgets hold |
| Security | Authz test matrix across every role × every endpoint |
| E2E | Two real browser sessions editing the same project see each other's changes |

### Exit criteria

- [ ] Conflict handling proven with zero data loss under concurrent edits
- [ ] Full authorization matrix tested, enforced at the data layer
- [ ] Sustained 500-VU load test passes
- [ ] Replica and Redis failures recover without correctness loss

---

## 12. Phase 8 — Export

**Goal:** get data back out, losslessly, in every supported open format. ~3–4 weeks.

### Steps

1. Streaming export jobs with server-side cursors (P6).
2. DXF writer using a direct-to-stream approach that avoids an in-memory document; **true arcs written as native `ARC` entities from `params`**, blocks written as definitions + inserts.
3. LandXML export (points, surfaces, alignments).
4. OGR-backed export: GeoPackage, Shapefile, GeoJSON, KML.
5. CSV point export with configurable columns.
6. SVG/PDF plot output.
7. Selection- and layer-scoped export, plus extent-scoped export.

### Tests

| Level | What |
|---|---|
| **Round-trip** | DXF in → DB → DXF out → re-import: geometry bit-exact where the format permits, entity counts equal, layers/blocks preserved |
| Integration | Arcs export as `ARC` entities, **never** as tessellated polylines (parse the output and assert entity types) |
| Integration | Blocks export as definitions + inserts, not exploded |
| Round-trip | LandXML round-trip preserves survey points, surfaces, and alignments |
| Integration | Shapefile export warns about its documented limitations (field names, 2 GB, no arcs) rather than silently degrading |
| Integration | GeoJSON export from a projected CRS either reprojects correctly or warns — no silent CRS error |
| Perf | 10M-entity DXF export within job budget, flat memory |
| Chaos | Export job interrupted → resumes or fails cleanly with no corrupt artifact left behind |
| E2E | Export from the UI, download, reopen the file in an external CAD viewer (manual verification step, documented and repeated per release) |

### Exit criteria

- [ ] Round-trip fidelity proven for DXF and LandXML
- [ ] Arcs and blocks preserved as first-class entities
- [ ] 10M export within budget
- [ ] Manual external-viewer verification passes

---

## 13. Phase 9 — Hardening and Release Readiness

**Goal:** operable, observable, and safe to run in production. ~4–6 weeks, then continuous.

### Steps

1. Prometheus metrics, Grafana dashboards for every §1 budget, OpenTelemetry tracing across API → tiles → DB.
2. Alerting on budget violations, cache hit-rate collapse, queue depth, replication lag.
3. Backup and restore: PostgreSQL WAL archiving + base backups, MinIO replication, documented and **rehearsed** restore procedure.
4. Performance regression suite in nightly CI with historical trending.
5. Security review: dependency audit, OWASP pass, authz matrix re-verification, rate limiting, upload validation (a malicious DXF is a real attack surface).
6. Accessibility pass on all non-canvas UI.
7. Operator documentation: install, upgrade, scale, backup, troubleshoot.
8. User documentation, including the explicit open-formats-only scope.
9. Upgrade/migration rehearsal on a production-sized dataset.

### Tests

| Level | What |
|---|---|
| Ops | **Restore from backup into a clean environment reproduces the full system** — rehearsed, not assumed |
| Ops | Rolling upgrade with zero data loss on a production-sized dataset |
| Security | Dependency vulnerability scan clean; upload validation rejects malformed and malicious files |
| Security | Rate limiting effective; authz matrix re-verified |
| Perf | Full budget suite green with 30-day trend showing no drift |
| Chaos | Full-stack failure injection: DB failover, Redis loss, worker pool exhaustion, disk full |
| Load | Sustained 24 h soak at 500 VUs — no memory leaks, no connection exhaustion, no unbounded queue growth |
| A11y | axe-core on all non-canvas UI |
| Manual | Exploratory testing session against real customer files |

### Exit criteria

- [ ] Restore drill completed successfully from scratch
- [ ] 24 h soak test clean
- [ ] All budgets green with trend data
- [ ] Security review closed
- [ ] Operator and user documentation complete

---

## 14. Sequencing, Effort, and Parallelism

Indicative durations assume a team of 3–5 engineers. Sequential total is roughly **10–13 months**; with the parallelism below, **8–10 months** is realistic.

| Phase | Duration | Can start when | Parallelizable with |
|---|---|---|---|
| 0 — Repo & CI | 1–2 wk | — | — |
| 1 — Foundations | 4–6 wk | 0 done | — (everything depends on it) |
| 2 — Read path & rendering | 6–8 wk | 1 done | Phase 3 |
| 3 — Import pipeline | 5–7 wk | 1 done | Phase 2 |
| 4 — Drawing & editing | 6–8 wk | 2 done | Phase 5 |
| 5 — Properties & metadata | 2–3 wk | 2 done | Phase 4 |
| 6 — Local mode | 6–8 wk | 4 done | Phase 7 |
| 7 — Multi-user | 4–6 wk | 4 done | Phase 6 |
| 8 — Export | 3–4 wk | 3 done | Phases 6, 7 |
| 9 — Hardening | 4–6 wk | All | continuous thereafter |

**Suggested split:** one engineer owns `geo-core` and the store contract through Phase 1, then moves to local mode (Phase 6) — the deepest continuity of context. Backend and frontend split across Phases 2/3. Import (Phase 3) benefits from someone with real DXF exposure; it is consistently underestimated because DXF in the wild is far messier than the specification suggests.

### Decision checkpoints

| After | Question to answer with data |
|---|---|
| Phase 2 | Do OpenLayers' renderers meet the fps budget on `large.dxf`? If not, invoke the custom WebGL renderer escape hatch (§5.1) **now**, while little depends on it |
| Phase 3 | Does the 10M import budget hold on *real* customer files, not just generated ones? |
| Phase 6 | Does OPFS behave acceptably across target browsers at multi-GB scale? If not, reconsider the local-mode ceiling |
| Phase 7 | Does the 500-VU load test hold on the actual on-prem hardware, not a developer laptop? |

---

## 15. Summary — The Ten Tests That Matter Most

If everything else were cut, these ten would still catch the failures that are hardest to recover from:

1. **TS ↔ Python CRS parity** — drift here corrupts data invisibly and is agonizing to diagnose.
2. **Bit-exact coordinate round-trip through every store** (G2) — precision loss is silent and permanent.
3. **Bit-exact snapping** — snapping to "nearly" the right vertex is a CAD tool that cannot be trusted.
4. **Import reconciliation, zero silent entity loss** — losing a customer's data quietly is unrecoverable reputationally.
5. **Store conformance suite passing on both implementations** (G3) — the guarantee that local and server modes are one product.
6. **No jitter at 1 mm zoom** — proves the float32 rebasing that is nearly impossible to retrofit.
7. **Concurrent-edit conflict with no data loss** — the core multi-user correctness property.
8. **Import resumability under chaos** — a 15-minute job that can't resume is a job that will ruin someone's afternoon repeatedly.
9. **Performance budgets on the 10M fixture** — the difference between "works in the demo" and "works at scale".
10. **Backup restore drill** — the only test whose absence can end the project.
