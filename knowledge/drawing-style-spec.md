# Style of objects while they are being drawn — specification

Status: **agreed with the product owner (2026-11-18, option B "white construction"); implemented** —
geometry rules in `apps/web/src/map/sketchGeometry.ts` (unit-tested in
`apps/web/test/sketchGeometry.test.ts`), OpenLayers styles in `apps/web/src/map/sketchStyle.ts`,
wiring in `apps/web/src/map/engine.ts`.
Related: [selection-spec.md](selection-spec.md), [snapping-spec.md](snapping-spec.md),
[line-tool-spec.md](line-tool-spec.md).

This document is the source of truth for how an unfinished object looks. If the code and this spec
disagree, the code is wrong unless this spec is updated first.

---

## 1. One style for every drawing tool

Point, Line, Polyline, Polygon, Circle and Arc (3 pt) all use the same in-progress style. No tool
uses OpenLayers' default sketch style or a style of its own.

## 2. Colour

| Drawing-area background (View menu) | In-progress colour | Vertex fill |
|---|---|---|
| Dark (default) | White-grey `#e5e7eb` | Background `#0b0f14` |
| Light | Dark grey `#374151` | Background `#f4f6f8` |

The colour must never be one of the other states' colours: finished objects (blue `#2b6cb0`),
hover (light blue `#3b82f6`), selected (orange `#e8590c`), snap target (green `#22c55e`).
Switching the background restyles a drawing in progress immediately.

## 3. Parts of an unfinished object

| Part | Look |
|---|---|
| **Placed part** — segments between vertices already clicked | Solid line, 2 px |
| **Rubber band** — the segment from the last placed vertex to the cursor | Dashed line (6 px dash, 5 px gap), 1.5 px |
| **Placed vertex** | Small hollow square (8 px), outline in the in-progress colour, filled with the background colour |
| **Cursor** | Crosshair `+` (16 px) |
| **Polygon closing edge** — cursor back to the first vertex | Dashed, like the rubber band (only once 2 vertices are placed) |
| **Polygon fill** | The in-progress colour at 8 % opacity |
| **Circle** — outline and radius guide (centre to cursor) | Dashed; the centre is shown as a placed vertex |
| **Arc preview** — the curve through the clicked points and the cursor | Dashed; clicked points are placed vertices |

## 4. Interaction with other states

- While a **snap target** is shown, the crosshair cursor is hidden, so the green marker is the only
  thing at that spot (snapping spec §5).
- **Line tool:** segments already created are real, stored objects and show in the normal finished
  style; only the start point and the rubber band are in progress (line spec §2).
- The in-progress style disappears the moment the object is finished or cancelled; the finished
  object then appears in its normal style.
