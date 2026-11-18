# Snapping while drawing — specification (v2)

Status: **agreed with the product owner (2026-11-17); implemented** — rules and geometry in
`apps/web/src/map/snapping.ts`, settings in `apps/web/src/snapSettings.ts` (both unit-tested in
`apps/web/test/`), map wiring in `apps/web/src/map/engine.ts`, menu in
`apps/web/src/components/SnapMenu.tsx`, browser tests in `apps/web/e2e/tools.spec.ts`
("snapping spec").
Scope: the web client (`apps/web`), drawing tools Point, Polyline, Polygon, Circle, Arc (3 pt).
Related: [selection-spec.md](selection-spec.md) §6 (drawing tools never select; no snap markers
other than the single active target).

This document is the source of truth for snapping. If the code and this spec disagree, the code is
wrong unless this spec is updated first.

v1 → v2: one "endpoint" mode became six independently selectable modes with a Snap menu, a fixed
priority, a marker per mode and remembered settings. The product owner's proposal of separate
**Start** and **End** modes was merged into **Endpoint** (a polygon's first vertex is both start and
end, and every inner polyline vertex is the end of one segment and the start of the next).

---

## 1. Snap modes

| Mode | Snaps to | Default |
|---|---|---|
| **Endpoint** | Point objects; every vertex of polylines and polygons; start and end of arcs | On |
| **Midpoint** | Middle of every polyline/polygon segment (including a polygon's closing segment); middle of an arc **along the arc** (not the chord) | On |
| **Centre** | Centre of circles and arcs | On |
| **Intersection** | Where two segments/arcs/circles cross — between different objects, or non-adjacent segments of the same object | On |
| **Perpendicular** | The point on a segment, arc or circle where a line from the **reference point** meets it at 90° | Off |
| **Nearest** | The closest point to the cursor anywhere along a segment, arc or circle | Off |

- Modes are independent; any combination can be on.
- Not modes (for now): Start/End separately, Quadrant, Tangent, Extension, Parallel, Apparent
  intersection, block Insertion point (Phase 4), snapping to imported backdrop objects (Phase 4).

## 2. Availability

| Mode | Point | Polyline | Polygon | Circle | Arc |
|---|---|---|---|---|---|
| Endpoint, Midpoint, Centre, Intersection, Nearest | Yes | Yes | Yes | Yes | Yes |
| Perpendicular | No | Yes* | Yes* | No | No |

\* Only once at least one vertex has been placed. The **reference point** is the last placed vertex
of the shape being drawn (clicked, snapped or typed). On the first click there is nothing to be
perpendicular to, so the mode is inactive.

Availability is decided by the active tool, not only by the checkbox: a ticked Perpendicular does
nothing in Point, Circle or Arc.

## 3. Choosing the active target

- Snap distance: **10 screen pixels** from the cursor, the same at every zoom.
- Every enabled and available mode produces candidates within that distance.
- **Strict priority** decides between modes; a higher-priority candidate in range always wins:
  1. Endpoint
  2. Midpoint
  3. Centre
  4. Intersection
  5. Perpendicular
  6. Nearest — only when nothing else is in range
- Within the same mode, the nearest candidate wins; an exact tie is broken by object id, so the
  result is deterministic.
- Candidates come from the objects around the **cursor**, not the screen centre.
- Only **one** target is shown at a time.

## 4. Accuracy

- **Endpoint** and **Centre** return the stored float64 coordinates **exactly**.
- **Midpoint, Intersection, Perpendicular, Nearest** are computed in float64 from the stored
  coordinates, in the drawing's CRS. They are exact to floating-point precision (far below a
  micrometre at survey coordinates), not stored values. A Nearest or Perpendicular point lies on its
  target geometry; arcs and circles use their true curve, never the tessellated display line.

## 5. What the user sees

| Mode | Marker (green) |
|---|---|
| Endpoint | Square (a snapped Point object is drawn as a bigger dot instead) |
| Midpoint | Triangle |
| Centre | Ring with a dot |
| Intersection | × |
| Perpendicular | Right-angle symbol |
| Nearest | Hourglass |

- The drawing preview jumps to the target, so the user sees where the click will land.
- The status bar names the mode: `SNAP · endpoint` / `midpoint` / `centre` / `intersection` /
  `perpendicular` / `nearest`.
- When nothing is in range, the marker disappears immediately.

## 6. Clicking

- A click while a target is shown places the point **at the target**, not where the mouse is.
- Applies to every click of every drawing tool: Point; every vertex of Polyline/Polygon; Circle
  centre and radius point; all three Arc points.
- With no target, the click lands exactly at the cursor.
- A Polygon still closes by clicking its own first vertex.
- Snapping never selects anything; no highlight remains after the click (selection spec §6).

## 7. Snap menu

- A **Snap ▾** button in the toolbar opens a dropdown. It shows whether snapping is on and how many
  modes are ticked.
- Menu contents:
  - **Snapping on (F3)** — master switch.
  - One row per mode in priority order: icon (the mode's marker), label, checkbox.
  - **Select all** / **Clear all**.
- Clicking a row toggles it; the menu stays open. Clicking outside or Esc closes it.
- Perpendicular is shown greyed out, with the tooltip "Only while drawing a polyline or polygon",
  when the active tool is not Polyline or Polygon.
- Ticked modes are **remembered per browser**; unreadable saved settings fall back to the defaults.
  Switching tools never changes them.

## 8. Turning snapping off

| Input | Effect |
|---|---|
| **F3** or the menu's master switch | Snapping on/off. The ticked modes are kept. Status bar: `SNAP` / `SNAP OFF`. Default on. |
| **Alt** held | Suspends snapping while held: no target, clicks land at the cursor. |

F3 and Alt are ignored while typing in a field.

## 9. Typed coordinates

Coordinates entered in the command line are **never** snapped; they are used exactly as typed. A
typed vertex does become the reference point for Perpendicular.
