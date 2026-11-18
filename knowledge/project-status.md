# Project status and handoff

Read this at the start of a session to pick up where the last one stopped. Update it at the end of
any session that changes status, decisions or open items.

Last updated: 2026-11-17.

---

## Phases

| Phase | Status |
|---|---|
| 0 Foundations (repo, Docker, CI) | Done |
| 1 Core geometry, store contract, in-memory store, demo UI | Done |
| 2 PostGIS store, MVT tile service, backdrop layer, budgets | Done. Deferred to Phase 9: visual regression baselines, 1 mm-zoom jitter test, k6 500-VU load test |
| 3 Import pipeline | **In progress** (see below) |
| 4 Editing (exact-geometry API, promote backdrop objects, edit tool) | Not started. Some UI groundwork done: tools, selection, menus |
| 5–9 Properties/metadata, local mode (SQLite-WASM/OPFS), multi-user, export, hardening | Not started. `apps/api` is still a placeholder |

### Phase 3 — done

- PostgreSQL job queue (`SELECT … FOR UPDATE SKIP LOCKED`, heartbeat reclaim, checkpoint in the same
  transaction as the rows).
- Streaming DXF import (ezdxf `iterdxf`), entity mapping, exact reconciliation
  (entities in file = written + unsupported + failed), resume from checkpoint.
- Douglas–Peucker LOD bit-identical between TypeScript and Python.
- Invalid polygons demoted to their exterior ring and tagged `degraded`.
- Block instancing (P5): definitions stored once, inserts as id + affine transform, expanded with
  `ST_Affine` at tile time. Block loading batched (50,000 definitions in ~51 round trips).
- Schema migrations (`docker/postgis/migrations`, `python -m wcad_workers.migrate`).
- Memory profiling and budgets in `.\wcad.ps1 import-bench`.

### Phase 3 — open

- **10M `import-bench` result was never reported back.** Budgets: < 15 min, peak < 2 GB, flat
  memory, exact reconciliation. Then `.\wcad.ps1 flush-tiles` + `.\wcad.ps1 bench` on the
  imported (instanced) data. If low-zoom tiles are slow, consider a partial index on instanced rows
  `(project_id, layer_id, bbox_diag DESC) WHERE block_id IS NOT NULL` — only after measuring.
- Chaos tests: kill the worker at 20/50/80 % and compare with an uninterrupted import.
- Remaining steps: chunked/resumable upload with checksum, tile warming, LandXML, GDAL/OGR formats,
  CSV/TXT point import, CRS assignment UI.

## Web client (apps/web) — current behaviour

- Toolbar: **Pan** (default), **Select**, Point, Polyline, Polygon, Circle, Arc (3 pt).
- Selection, right-click menus and keyboard: see [selection-spec.md](selection-spec.md) (agreed spec,
  implemented). Rules in `src/map/selection.ts`, tool rules in `src/map/toolRules.ts`, map wiring in
  `src/map/engine.ts`.
- Snapping while drawing: see [snapping-spec.md](snapping-spec.md) v2 (agreed, implemented). Modes
  Endpoint, Midpoint, Centre, Intersection, Perpendicular, Nearest (strict priority in that order),
  one marker per mode, **Snap ▾** toolbar menu with checkboxes, remembered per browser; F3 toggles,
  Alt suspends. Engine in `src/map/snapping.ts`, menu in `src/components/SnapMenu.tsx`.
- View menu (right-click empty space): Basemap, Dark/Light background, Performance readout;
  saved per browser (`src/viewSettings.ts`).
- Backdrop tile grid is bounded by the pyramid extent (`src/map/tileGrid.ts`). Tile failures are
  logged to the browser console and the last one shows on hover over "N tile errors".

## Known limitations

- Objects drawn in the app live only in browser memory (`MemoryStore`); a page reload loses them.
- Only drawn (working-set) objects are selectable; imported backdrop objects need Phase 4.
- The browser e2e specs (`apps/web/e2e/tools.spec.ts`) have not been run as a suite yet (the
  snapping flows were verified by hand in the built-in browser against the running stack):
  `docker compose --profile tools run --rm e2e pnpm --filter @wcad/web exec playwright test tools.spec.ts`
- PostGIS logs "checkpoints are occurring too frequently" during large imports; raising
  `max_wal_size` would fix it (not done).
- `.pnpm-store/` was staged in git by mistake; it is now ignored. If still staged, unstage it:
  `git rm -r -q --cached .pnpm-store`.

## Recent session log

- 2026-11-02: Select read-only + highlight; drag-rectangle selection (window/crossing);
  Shift/Ctrl; Pan tool; right-click object menu in every tool; view menu with saved settings;
  Del key; snap markers hidden. Fixed "N tile errors" + vanishing drawing when zoomed out
  (client grid lacked an extent; server now returns 404 for out-of-pyramid tiles).
- 2026-11-13: Snapping per snapping-spec.md (own interaction replacing OpenLayers Snap; candidates
  fetched around the cursor instead of the screen centre). Fixed: right-click in a drawing tool
  added a vertex instead of opening the menu (Draw now accepts the left button only).
- 2026-11-17: Snapping v2 — six modes, Snap menu, per-mode markers, geometry cache from exact
  records (queryBBox) instead of vertex-only candidates; Perpendicular uses the sketch's last placed
  vertex. Fixed: Esc closing the Snap menu also switched a drawing tool back to Select. Open
  question raised with the product owner: strict priority makes an Intersection within 10 px of a
  segment Midpoint unreachable without zooming in.
