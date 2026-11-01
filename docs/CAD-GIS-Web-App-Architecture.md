# CAD/GIS Web Application — Architectural Overview (v2, scale-first)

> **What changed from v1:** v1 was a reasonable design for ordinary CAD projects with scale bolted on at the end. This version is rebuilt around the real target — **DXF/CAD files containing millions of objects, 50–500 concurrent users, self-hosted on-premise, and full-size local files that must work entirely in the browser**. Scale is now a structural property of the design, not a later optimization.

**Target profile (agreed):**

| Dimension | Target |
|---|---|
| Objects per drawing | Millions (design ceiling: 10M entities) |
| Concurrent users | 50–500 |
| Deployment | Self-hosted / on-premise, no cloud-vendor dependencies |
| Local file mode | Must handle multi-million-object DXF fully client-side |

---

## 1. Performance Budgets

These are the numbers the architecture is designed to hit. They exist so that "is it fast enough?" is a measurable question, not an opinion, and so regressions get caught in CI rather than in the field.

| Operation | Budget |
|---|---|
| Initial view of a 10M-object drawing | First meaningful paint < 2 s |
| Pan / zoom | Sustained 60 fps; never below 30 fps |
| Cursor hover → element highlight | < 16 ms (one frame), zero network |
| Snap candidate resolution | < 16 ms, from local index |
| Commit an edit (shared mode) | < 200 ms round trip |
| Tile serve (cache hit) | < 20 ms |
| Tile generate (cache miss) | < 300 ms |
| DXF import, 10M entities | < 15 min background job, with progress |
| Open 2 GB local DXF (client-side) | < 3 min one-time indexing, instant thereafter |
| Client RAM at 10M objects | < 1.5 GB |

## 2. Design Principles

Six rules that everything else follows from. If a proposed change violates one of these, it's wrong.

**P1 — Separate the display representation from the authoritative representation.**
Display data is generalized, quantized, tiled and lossy. Authoritative data is full double precision and exact. They are different pipelines with different formats. **Nothing is ever edited, measured, or snapped-to using display data.** This is the rule that lets a CAD app use GIS tiling technology without becoming imprecise — and it's the one most commonly gotten wrong.

**P2 — Work is proportional to what's on screen, never to drawing size.**
Every read path is bbox- or tile-scoped with level-of-detail. Opening a 10M-object drawing and a 10k-object drawing must cost roughly the same.

**P3 — The backend never sees interaction.**
Hover, hit-testing, snapping, rubber-banding, selection, tessellation are all client-side against local indexes. The backend sees only committed changes, auth, and tile/data requests. This is what makes 500 concurrent users cheap.

**P4 — One storage interface, two implementations.**
Server (PostGIS) and browser (SQLite WASM on OPFS) implement the *same* store contract. The application layer doesn't know which one it's talking to. This is what makes "huge local file" and "huge server project" the same feature rather than two products.

**P5 — Instance, don't explode.**
DXF blocks/inserts, repeated symbols, and shared geometry are stored once with transforms. A drawing with 5M objects is very often 50k unique definitions × 100 placements. Exploding them multiplies your problem by 100× for no benefit.

**P6 — Everything large is a job, not a request.**
Import, export, reprojection of whole drawings, tile pyramid builds — all queued, chunked, resumable, with progress. No HTTP request ever does unbounded work.

## 3. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                 │
│                                                                         │
│  React/TS UI shell ── toolbar, command line, layers, properties panel    │
│         │                                                               │
│  ┌──────┴───────────────────────────────────────────────────────────┐   │
│  │ MAP ENGINE (OpenLayers)                                           │   │
│  │  ┌─────────────────────────┐   ┌──────────────────────────────┐  │   │
│  │  │ BACKDROP LAYER          │   │ WORKING-SET LAYER            │  │   │
│  │  │ read-only, tiled (MVT)  │   │ full-precision ol/Feature    │  │   │
│  │  │ LOD by zoom, no Feature │   │ viewport-scoped, editable    │  │   │
│  │  │ objects → millions ok   │   │ Draw/Modify/Snap operate here│  │   │
│  │  └─────────────────────────┘   └──────────────────────────────┘  │   │
│  │  Local indexes: RBush (hit-test/snap) · arc tessellation cache    │   │
│  │  Coordinate rebasing to render origin (float32 safety)            │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│         │                                                               │
│  ┌──────┴──────────────────────┐                                        │
│  │ STORE ADAPTER (P4)          │                                        │
│  │  ├─ RemoteStore → HTTP/WS   │──────────────────────┐                 │
│  │  └─ LocalStore  → SQLite    │                      │                 │
│  │       WASM + OPFS + R*Tree  │                      │                 │
│  │       (Web Worker)          │                      │                 │
│  └─────────────────────────────┘                      │                 │
└───────────────────────────────────────────────────────┼─────────────────┘
                                                         │
                            ┌────────────────────────────┴──────────────┐
                            │ nginx / Traefik — TLS, routing, tile cache│
                            └────────────────────────────┬──────────────┘
                   ┌─────────────────────────────────────┼──────────────────────┐
                   ▼                                     ▼                      ▼
      ┌────────────────────────┐        ┌────────────────────────┐  ┌──────────────────────┐
      │ API (NestJS) × N       │        │ TILE SERVICE × N       │  │ IMPORT/EXPORT WORKERS│
      │ stateless              │        │ read-only, stateless   │  │ (Python, × M)        │
      │ - auth / rights        │        │ - ST_AsMVT from PostGIS│  │ - streaming DXF/LandXML│
      │ - elements CRUD        │        │ - LOD select by zoom   │  │ - LOD pyramid build  │
      │ - exact-geometry API   │        │ - Redis + disk cache   │  │ - GDAL/OGR, pyproj   │
      │ - snap-candidate API   │        │ - dirty-tile invalidat.│  │ - resumable, chunked │
      │ - WS rooms (edits)     │        └───────────┬────────────┘  └──────────┬───────────┘
      └───────────┬────────────┘                    │                          │
                  │           ┌────────────────────┴──────────┐               │
                  ├───────────┤ Redis — tile cache, WS pub/sub,│               │
                  │           │ job queue (BullMQ), soft locks │◄──────────────┤
                  │           └───────────────────────────────┘               │
                  ▼                                                            ▼
      ┌──────────────────────────────────────┐              ┌────────────────────────────┐
      │ PostgreSQL + PostGIS (primary +      │              │ MinIO / filesystem          │
      │ read replicas, PgBouncer)            │              │ - original uploaded files   │
      │ - elements, partitioned by project   │              │ - cold tile pyramids        │
      │ - LOD geometry columns (GiST)        │              │ - export artifacts          │
      │ - metadata JSONB (GIN)               │              └────────────────────────────┘
      │ - block definitions + instances (P5) │
      └──────────────────────────────────────┘
```

Everything in that diagram runs from a single `docker compose` file for a small install, or a Helm chart on-prem Kubernetes for the 500-user case. No managed cloud service is required anywhere.

## 4. Storage Layer

### 4.1 Primary store: PostgreSQL + PostGIS (revised recommendation)

**v1 proposed MongoDB as the primary store. At millions of objects that is the wrong choice and I'd recommend changing it.** The reasons are concrete:

- MongoDB's `2dsphere` index is defined on spherical lon/lat. Your data is in projected or local engineering CRS (X/Y/Z, N/E/H), so the one real spatial index Mongo offers doesn't apply — you'd be left doing bounding-box range scans on ordinary indexes, which is exactly what falls over at 10M rows.
- Tile generation is the hot read path, and PostGIS does it natively and extremely well: `ST_AsMVT` is parallelizable and its clipping/simplification path was substantially optimized in PostGIS 3, to the point where projects with very heavy tiling requirements standardize on it. There is no equivalent in MongoDB — you'd be building tile assembly in application code.
- Geometry and its metadata should change atomically. One transactional database gives you that for free.
- On-premise, every additional datastore is another thing to install, back up, monitor and patch. Dropping one is a real operational win.

**Your original requirement was schema-less JSON metadata attached to CAD elements. PostgreSQL `JSONB` satisfies that requirement fully** — arbitrary nested JSON per element, no migrations, GIN-indexed so you can query inside it (`metadata @> '{"material":"steel"}'`). You keep the NoSQL *capability* while losing a NoSQL *server*.

MongoDB remains a legitimate option if you have an organizational reason to keep it (existing infrastructure, an existing metadata corpus, a team that knows it). In that case run it **alongside** PostGIS as a metadata-only store keyed by element id, and accept that geometry↔metadata consistency becomes eventually-consistent and your ops footprint grows. The store adapter in §7 hides the difference from the application either way.

### 4.2 Schema

```sql
-- Partitioned by project so a huge project never slows down other projects,
-- and so DROP PARTITION makes project deletion instant.
CREATE TABLE elements (
  id            bigserial,
  project_id    bigint      NOT NULL,
  layer_id      bigint      NOT NULL,
  kind          smallint    NOT NULL,   -- point/line/polyline/polygon/arc/circle/text/insert
  srid          integer     NOT NULL,   -- or negative id referencing a local CRS definition

  -- AUTHORITATIVE geometry: full double precision, never generalized (P1)
  geom          geometry    NOT NULL,
  z_values      double precision[],     -- per-vertex Z where the CRS is 2D+H
  -- canonical parametric form for true CAD primitives (arcs/circles), so precision
  -- survives transforms; tessellation is derived, never stored as the source of truth
  params        jsonb,                  -- {center,radius,startAngle,endAngle,bulge,...}

  -- DISPLAY geometry: pre-generalized LOD pyramid, built once on import (P1, P2)
  geom_lod1     geometry,               -- ~1 m tolerance
  geom_lod2     geometry,               -- ~10 m
  geom_lod3     geometry,               -- ~100 m
  bbox          box2d       NOT NULL,   -- denormalized for cheap culling

  block_id      bigint,                 -- P5: reference to a block definition
  transform     double precision[6],    -- affine placement for block instances

  style_id      integer,
  metadata      jsonb,                  -- free-form, schema-less (the NoSQL requirement)

  version       integer     NOT NULL DEFAULT 1,
  created_by    bigint, created_at timestamptz,
  updated_by    bigint, updated_at timestamptz,
  deleted_at    timestamptz             -- soft delete, keeps history coherent
) PARTITION BY LIST (project_id);

CREATE INDEX ON elements USING GIST (geom);
CREATE INDEX ON elements USING GIST (geom_lod1);
CREATE INDEX ON elements USING GIN  (metadata jsonb_path_ops);
CREATE INDEX ON elements (project_id, layer_id) INCLUDE (bbox);

-- P5: geometry stored once, placed many times
CREATE TABLE block_definitions (
  id bigserial PRIMARY KEY, project_id bigint, name text,
  geometry_blob bytea,        -- compact binary of the definition's entities
  bbox box2d, entity_count integer
);
```

Supporting tables: `projects` (active CRS, extent, render origin), `layers`, `styles` (deduplicated — a million elements share a few hundred styles; never store style JSON per element), `element_history` (append-only change log, partitioned by month with a retention policy), `users`, `project_members`, `dirty_tiles`.

### 4.3 Why LOD columns instead of simplify-on-the-fly

Simplifying inside every tile request means paying the geometry-processing cost on every cache miss, for every user, forever. Precomputing three generalized copies at import time costs disk (roughly +40%, which is cheap) and turns tile generation into an index scan plus an aggregate. Rebuild of the LOD columns for edited elements is incremental and handled by the same worker pool that does imports (P6).

## 5. Read Path — Tiles and Level of Detail

The read path exists to answer one question fast: *what should be drawn in this viewport at this zoom?*

0. **The tile pyramid is cut in the project's own CRS**, not Web Mercator. Project data lives in a projected or local engineering CRS and is never reprojected at rest (§9), so tiling in Web Mercator would force a datum transformation between the user and their own survey coordinates, and would be both slower and lossy. Nothing in the MVT specification requires Web Mercator — a tile is just a quantized grid cell — so the pyramid is anchored on the project extent, keeping every tile boundary at an exact power-of-two subdivision of coordinates the surveyor recognizes. Client and server share one `TileScheme` definition so their grids cannot drift.
1. **Zoom → LOD selection.** Low zoom serves `geom_lod3` and drops any element whose bbox is under ~4 px; high zoom serves the exact `geom`. Element-count caps per tile with a deterministic importance ordering (by size, then layer priority) keep worst-case tiles bounded.
2. **Tile generation.** `ST_AsMVT` over the selected LOD column, one MVT layer per CAD layer (or per layer group), so toggling layer visibility is a client-side operation and never invalidates the cache.
3. **Caching, three tiers.** Redis for hot tiles (in-memory, shared across API replicas) → MinIO/filesystem for cold tiles → generate on miss. nginx serves cached tiles directly without touching Node. Given a mostly-read workload from 50–500 users, hit rates should be very high.
4. **Invalidation.** An edit writes affected tile coordinates across all zoom levels into `dirty_tiles`. Tiles are *not* eagerly regenerated — they're evicted and rebuilt lazily on next request, so a burst of edits doesn't cause a regeneration storm.
5. **Read replicas.** Tile services read from PostgreSQL replicas; only the API writes to the primary. This is what lets you scale reads independently of edits.

**MVT is deliberately lossy and that is fine — because of P1.** The spec quantizes coordinates onto an integer grid (typically 4096×4096 per tile), so tile geometry is approximate by construction. That's acceptable for pixels and unacceptable for CAD. Hence: tiles feed the backdrop only; the exact-geometry API (§6.1) feeds everything that matters.

### 5.1 Rendering in OpenLayers

- **Backdrop:** `ol/layer/VectorTile` consuming the MVT endpoint, `renderMode: 'hybrid'` (polygons and lines rasterized, text/symbols kept as vectors). This is where the millions of objects live, and no `ol/Feature` object is created for them.
- **Working set:** `WebGLVectorLayer` — since OL 10.4 the WebGL vector renderer handles lines and polygons as well as points, with triangulation and line-offset computation moved to a worker off the main thread. Fed by bbox-strategy loading of exact geometry.
- **Escape hatch:** if OL's renderers become the bottleneck at the extreme end, a custom `ol/layer/Layer` with a hand-written WebGL renderer over shared typed-array buffers keeps you inside the OpenLayers ecosystem (view, projections, interactions) without inheriting its renderer. Worth prototyping early enough that switching isn't traumatic — note that OL's WebGL *vector tile* renderer specifically is not yet a clear win over canvas, which is why the backdrop above uses canvas hybrid mode.

### 5.2 Float32 precision — the trap that will bite you

GPUs work in 32-bit floats (~7 significant decimal digits). A UTM northing like `4650321.104` cannot be represented in float32 without losing centimetre-level detail, so a naive WebGL CAD renderer produces visible vertex jitter and wobbling geometry when zoomed in — a classic and very confusing bug.

**Fix, applied everywhere on the GPU path:** each project has a **render origin**; all coordinates are rebased (`x - originX`, `y - originY`) in float64 on the CPU before being uploaded as float32. The origin is re-chosen when the view moves far from it. The authoritative store always keeps absolute float64. Build this into the buffer-upload layer from day one — retrofitting it means auditing every shader.

## 6. Write Path — Precision, Snapping, Concurrency

### 6.1 Exact-geometry API

When the user is about to interact with an element (hover-select, enter edit mode, open properties), the client fetches its **authoritative** geometry — full float64, exact parametric arcs, no generalization — and promotes it into the working-set layer. This is a small, targeted request against an indexed primary key or bbox, and it's what guarantees CAD correctness while the backdrop stays cheap.

### 6.2 Snapping at millions-of-objects scale

Snapping must be exact and instant, and `ol/interaction/Snap` indexes its entire source, so it must never be pointed at the whole drawing.

- A **snap-candidate endpoint** returns exact vertices/edges within a small bbox around the cursor region, hard-capped in count and prioritized by proximity.
- The client keeps these in an **RBush** R-tree, refreshed on view change with a generous margin, and feeds a bounded `Collection` to `Snap`.
- Grid snap and orthogonal/angle-lock snap are computed analytically — no index needed at all.
- Intersection snap is computed on demand against the small candidate set only, never globally.
- In local mode the identical query runs against the SQLite R\*Tree index (§7), so the behaviour is byte-for-byte the same offline.

### 6.3 Concurrency

Optimistic concurrency on the `version` column: the client submits the version it started from, the server commits and bumps on match or returns a conflict on mismatch. Batched commits (one transaction per user action, even if it touches many elements) keep write volume proportional to *actions*, not input events (P3). Soft advisory locks in Redis with a short TTL — broadcast to the project's WS room so collaborators see "element being edited by X" — reduce conflicts but are UX only; the version check remains the correctness guarantee, since any lock can be lost to a closed tab.

Undo/redo is a **client-side command stack** (inverse operations), not a server round trip. The server-side `element_history` log exists for audit and recovery, and is a different thing with a different lifetime.

## 7. Local File Mode at Full Scale

You asked for multi-million-object DXF files to work locally. That's achievable, and the way to do it without writing the whole app twice is **P4: the same store contract, a different implementation.**

```
interface GeometryStore {
  queryTile(z, x, y, layers): MVTBuffer          // display, generalized
  queryExact(ids | bbox): Element[]              // authoritative, float64
  snapCandidates(bbox, limit): Vertex[]
  commit(changes, baseVersion): CommitResult
  subscribe(cb): Unsubscribe                     // no-op locally
}
```

`RemoteStore` talks HTTP/WebSocket to the backend. `LocalStore` runs **SQLite compiled to WebAssembly on the Origin Private File System**, inside a dedicated Web Worker. Multi-gigabyte client-side databases run at near-native speed on OPFS, and IndexedDB is not a substitute — it degrades badly at this data size. SQLite's built-in **R\*Tree** module provides the spatial index with no extension needed, which matters because exotic extensions are painful to build for WASM. Note that OPFS's fast synchronous access path is only available inside a Worker, which is why the store is worker-resident by design rather than by accident.

**Opening a huge local DXF:**

1. User picks the file (File System Access API). Nothing is loaded into memory yet.
2. A Worker **streams** the file, tokenizing DXF's group-code/value line pairs incrementally — ASCII DXF is line-pair structured, so a streaming tokenizer is straightforward and never materializes the file.
3. Entities are inserted into OPFS-backed SQLite in batched transactions, blocks stored as definitions plus instances (P5), R\*Tree rows written alongside, with a progress bar throughout.
4. A local LOD pyramid is generated in the background (same generalization tolerances as the server) so the backdrop renders at all zooms.
5. **Indexing happens once.** The OPFS database persists, so reopening the same file is instant.

After step 5 the app behaves identically to server mode — the UI layer genuinely cannot tell which store it's using. That property is worth protecting with tests that run the same interaction suite against both implementations.

Honest caveats: the one-time indexing pass is unavoidable (you cannot spatially query a DXF file in place); OPFS storage consumes real disk under the browser profile and needs a quota/eviction story with clear user messaging; and local mode is inherently single-editor with no locking or merge semantics, by design. A "publish to server project" path converts a local file into a shared project by streaming its SQLite contents through the import pipeline.

## 8. Import / Export Pipeline

Millions of entities means import is a **job, never a request** (P6).

### 8.1 Supported formats — open only

**Decision: the platform supports open, publicly documented formats exclusively.** No proprietary-SDK dependency, no per-seat converter licence, nothing that complicates an on-prem install. This removes the single biggest licensing risk from the project and simplifies deployment considerably.

| Format | Direction | Notes |
|---|---|---|
| **DXF** (ASCII, R12→R2018) | in / out | Primary CAD interchange. Publicly documented, fully covered by `ezdxf`. True arcs, blocks, layers, Z all map natively |
| **LandXML** | in / out | Highly relevant for geodesy/survey work — survey points, surfaces (TIN), alignments, parcels. Plain XML, streamable with `lxml.iterparse` |
| **GeoPackage** | in / out | OGC standard, SQLite-based. The best general-purpose GIS container and a natural fit given SQLite is already in the stack |
| **GeoJSON** | in / out | Ubiquitous; native to OpenLayers. Lon/lat only per spec — warn on precision when exporting projected data |
| **Shapefile** | in / out | Legacy but unavoidable in practice. Note its real limits (2 GB, 10-char field names, no arcs, no true Z semantics) |
| **KML/KMZ** | in / out | Visualization/exchange with Google Earth |
| **CSV / TXT point lists** | in / out | Survey workflows: `id, N, E, H, code`. Configurable column mapping and delimiter |
| **SVG / PDF** | out only | Plot and drawing output |

DXF and LandXML together cover essentially all CAD and survey interchange your users will need; the GIS formats go through GDAL/OGR in the worker, so adding another OGR-supported open format later is configuration, not code.

**DWG is explicitly out of scope.** Users convert to DXF in their own CAD software. Document this clearly in the UI's import dialog so it's an understood product boundary rather than a surprise.

### 8.2 Pipeline

- **DXF, server side:** `ezdxf`'s `iterdxf` add-on iterates modelspace entities one at a time and is explicitly built for files too large to fit in memory (>5 GB), which is exactly this case. Entities stream into PostGIS via chunked `COPY` in batches of ~10k. Never `ezdxf.readfile()` a large drawing — that loads the whole document.
- **Pipeline stages:** upload to MinIO → parse & normalize → CRS assignment → bulk load → build LOD pyramid → warm tiles for the initial extent → mark project ready. Each stage is separately resumable, so a failure at 8M entities doesn't restart from zero.
- **Progress** is streamed to the user over the existing WebSocket channel.
- **Export** is the mirror image: stream out of PostGIS with a server-side cursor, write with `ezdxf`'s `r12writer`-style direct-to-stream writer that avoids building an in-memory document, and hand back an artifact URL. True arcs export as native DXF `ARC` entities from `params`, never as tessellated polylines (P1).
- Workers scale horizontally and independently — they're CPU-bound and bursty, so 2–4 replicas comfortably cover a 500-user install where imports are occasional.

## 9. Coordinate Systems

Unchanged in intent from v1, with scale-driven additions:

- Per-project **active CRS**: geographic (EPSG:4326), projected (UTM, national grids), or a local engineering system (origin + rotation + scale). Axis labels follow the CRS — X/Y/Z, N/E/H, or Lon/Lat — rather than being hardcoded.
- Definitions registered via `proj4.defs()` and bound into OpenLayers with `register()`, from a **shared CRS registry package** imported by the web app, the API, and the Python workers, so all three transform identically. (For Python, generate the registry from the same source of truth rather than maintaining a parallel copy — drift here produces bugs that are extremely hard to diagnose.)
- **Data is stored in one CRS per project and never implicitly reprojected at rest.** Reprojecting a 10M-object drawing is a background job with a progress bar, not a view setting.
- Per-vertex Z / H is carried in `z_values`, kept out of the 2D spatial index (which stays 2D for speed), and used by measurement and export.

## 10. Drawing Tools, Arcs, and the Properties Panel

- **Native geometry** (Point, LineString, Polygon, Circle) uses `ol/interaction/Draw`; `Modify` for editing; `Snap` fed the bounded candidate set from §6.2.
- **Arcs are not a native OpenLayers geometry.** A custom `ArcGeometry` stores the canonical parametric definition (center, radius, start/end angle; convertible to and from AutoCAD bulge) and tessellates only for display. Tessellation is cached per element per zoom bucket with segment count adapted to on-screen radius — at millions of objects, re-tessellating every frame is one of the easiest ways to lose your frame budget.
- **Typed coordinate entry** (absolute `X,Y,Z` / `N,E,H`, relative, polar `@length<angle`) feeds the *same* in-progress geometry builder as mouse input, so there is exactly one code path producing geometry.
- **Right-click** is a DOM `contextmenu` handler plus `forEachFeatureAtPixel` hit-testing (OpenLayers has no built-in context menu). Hit-testing runs against the client-side RBush index — no network, satisfying the < 16 ms budget regardless of drawing size.
- **Properties panel** shows built-in properties plus a JSON metadata editor bound to the element's `metadata` JSONB. **Metadata is fetched lazily**, only when the panel opens — it must never ride along with geometry on the render path, or it will dominate your bandwidth at scale.

## 11. Multi-User and Deployment Topology (50–500 users, on-prem)

**What actually crosses the network per user:** tile requests (heavily cached, mostly served by nginx), occasional exact-geometry fetches, and small commit messages. Hover, snap, selection and tessellation cost the backend nothing (P3). This is why a few hundred concurrent users is a modest load rather than a scaling crisis.

- **API replicas:** stateless, 3–5 behind nginx/Traefik. Scale on CPU.
- **Tile service:** separate deployment so heavy rendering traffic can't starve edit traffic, reading from PostgreSQL replicas.
- **Redis:** tile cache + WebSocket pub/sub backplane (so a project room spans API replicas) + BullMQ job queue + soft locks. One instance with persistence is enough at this size; Sentinel if you want HA.
- **PostgreSQL:** primary + 1–2 streaming replicas, **PgBouncer** in transaction mode in front (500 users × several connections will exhaust `max_connections` without it — a very common on-prem failure).
- **MinIO** (or a plain mounted filesystem): uploads, cold tiles, export artifacts. S3-compatible without any cloud dependency.
- **WebSocket rooms are per project**, carrying only confirmed edits plus optional throttled presence (~10 Hz, never persisted, safe to drop under load).
- **Observability:** Prometheus + Grafana + OpenTelemetry traces. Track the §1 budgets as actual dashboards — tile cache hit rate, p95 tile generation, commit latency, import throughput.
- **Backup:** PostgreSQL WAL archiving + periodic base backups; MinIO replication. Tiles are derived data and need no backup — they rebuild.

## 12. Repository Layout

```
/apps
  /web              React + OpenLayers SPA
  /api              NestJS: auth, elements, commits, WS rooms
  /tiles            Tile service (Node or Go; read-only, horizontally scaled)
  /workers          Python: DXF/LandXML/OGR import-export, LOD builds, reprojection
/packages
  /geo-core         Shared TS: CRS registry, arc math, generalization, rebasing
  /store-contract   GeometryStore interface + conformance test suite (P4)
  /store-local      SQLite-WASM/OPFS implementation
  /store-remote     HTTP/WS implementation
/deploy
  /compose          Single-node docker compose
  /helm             On-prem Kubernetes chart
```

The conformance test suite in `/packages/store-contract` is the mechanism that keeps local and server modes honest — both implementations must pass the identical suite.

## 13. Phased Build Order

Ordered so that each phase produces something demonstrable and so that the expensive-to-retrofit decisions land first. **See `IMPLEMENTATION-PLAN.md` for the step-by-step expansion of each phase, with its test suite and exit criteria** (it adds a Phase 0 for repository and CI setup ahead of the phases below).

1. **Foundations.** CRS registry, arc math, `GeometryStore` contract + conformance suite, coordinate rebasing, backdrop/working-set layer split. *Nothing user-visible; everything downstream depends on it.*
2. **Server read path.** PostGIS schema, LOD columns, `ST_AsMVT` tile service, Redis cache. Render a large pre-loaded drawing at 60 fps.
3. **Import pipeline.** Streaming DXF → PostGIS → LOD pyramid, as a job with progress. *Now you can load real customer files and validate the budgets against reality rather than synthetic data.*
4. **Drawing and editing.** Draw/Modify, typed coordinate entry, exact-geometry API, bounded snapping, client-side undo stack.
5. **Properties and metadata.** Right-click menu, lazy metadata fetch, JSONB editor.
6. **Local mode.** SQLite-WASM/OPFS store, streaming client-side DXF indexing. *Passes the same conformance suite as the server store.*
7. **Multi-user.** Auth, rights, optimistic-concurrency commits, per-project WS rooms, dirty-tile invalidation.
8. **Export**, arcs as native DXF entities.
9. **Hardening.** Presence/soft locks, observability dashboards, backup/restore drills, performance regression tests in CI.

**Do not defer phase 1.** Every item in it is cheap now and extremely expensive to retrofit — particularly the layer split, the store contract, and float32 rebasing.

## 14. Principal Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| OpenLayers renderer ceiling | OL is a GIS library; at CAD extremes it may not reach 60 fps even with WebGL | Prototype the custom WebGL layer early (§5.1) so the escape hatch is proven, not theoretical |
| OPFS quota/eviction | Browser may evict a multi-GB local database | Request persistent storage, surface usage in the UI, make re-indexing graceful rather than catastrophic |
| Precision regressions | A single place that edits from tile geometry silently corrupts drawings | Enforce P1 in code review and with tests asserting round-trip coordinate equality |
| Tile invalidation storms | Bulk edits marking millions of tiles dirty | Lazy rebuild + coalescing; cap dirty-tile writes per commit |
| Import correctness | DXF is a sprawling format; silent entity loss is worse than failure | Entity-count reconciliation per import, with an explicit unsupported-entity report |

---

### Decisions — resolved

| Decision | Resolution |
|---|---|
| Deployment | Self-hosted / on-premise; no cloud-vendor dependencies anywhere in the stack |
| Concurrent users | 50–500; topology per §11 |
| Local file mode | Must handle multi-million-object files fully client-side (§7) |
| File formats | **Open formats only** (§8.1). DXF + LandXML for CAD/survey, OGR-backed formats for GIS. DWG out of scope |
| Primary store | **PostgreSQL + PostGIS with JSONB metadata** (§4.1). Adopted as the default; MongoDB is not part of the stack unless a specific organizational need reopens it |
| Client geometry precision | float64 authoritative everywhere; float32 only after rebasing to the render origin (§5.2) |

### Decisions still open (low urgency — none block phase 1)

- **Local-mode ceiling:** default is a soft warning above ~2 GB / 10M entities with an option to continue; confirm whether you want a hard cap instead.
- **CRS presets:** which national systems ship built in (e.g. Bulgarian BGS2005 / 1970 / KC1970 zones) versus users supplying proj4 strings. The registry is pluggable either way, so this is a content decision, not an architectural one.
- **Retention:** how long granular `element_history` is kept before roll-up (default proposal: 90 days granular, then monthly snapshots).

---

### Sources

- [OpenLayers v10.4.0 release notes](https://github.com/openlayers/openlayers/releases/tag/v10.4.0) — WebGLVector renderer covering points, lines and polygons
- [OpenLayers WebGL rendering system](https://deepwiki.com/openlayers/openlayers/3.2-webgl-rendering-system) — worker-based triangulation and buffer generation
- [OpenLayers VectorTileLayer API](https://openlayers.org/en/latest/apidoc/module-ol_layer_VectorTile-VectorTileLayer.html) — `image` / `hybrid` / `vector` render modes
- [OpenLayers Snap interaction](https://openlayers.org/en/latest/apidoc/module-ol_interaction_Snap-Snap.html)
- [Waiting for PostGIS 3: ST_AsMVT Performance](https://blog.cleverelephant.ca/2019/08/postgis-3-mvt.html) — parallelized aggregate, wagyu clipping, simplification improvements
- [Serving Dynamic Vector Tiles from PostGIS](https://www.crunchydata.com/blog/dynamic-vector-tiles-from-postgis)
- [Mapbox Vector Tile Specification](https://mapbox.github.io/vector-tile-spec/) — integer grid quantization (lossy by design)
- [ezdxf `iterdxf` add-on](https://ezdxf.readthedocs.io/en/stable/addons/iterdxf.html) — streaming iteration over >5 GB DXF files
- [ezdxf `r12writer`](https://ezdxf.readthedocs.io/en/stable/addons/r12writer.html) — direct-to-stream writing without an in-memory document
- [SQLite Wasm backed by OPFS (Chrome for Developers)](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system) — worker-only synchronous access path
- [SQLite WASM persistence options](https://sqlite.org/wasm/doc/trunk/persistence.md)
- [The Current State of SQLite Persistence on the Web (May 2026)](https://powersync.com/blog/sqlite-persistence-on-the-web) — multi-GB databases at near-native speed; OPFS concurrency limits
- [Vector Data Rendering Performance Analysis of Open-Source Web Mapping Libraries](https://agris.fao.org/search/fr/records/68caacf6f61e5b80b5e8f917) — canvas rendering falls off past ~10k features
