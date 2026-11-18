# Line tool — specification

Status: **implemented 2026-11-18 at the product owner's request; awaiting review.** The Line
drawing modes and geometric construction operations to follow will build on it. Rules in
`apps/web/src/map/lineChain.ts` (unit-tested in `apps/web/test/lineChain.test.ts`), wiring in
`apps/web/src/map/engine.ts`, browser tests in `apps/web/e2e/tools.spec.ts` ("line tool").

This document is the source of truth for the Line tool. If the code and this spec disagree, the
code is wrong unless this spec is updated first.

---

## 1. Line vs Polyline

| | **Line** | **Polyline** |
|---|---|---|
| Stored object | Kind `line`, exactly **2 vertices** | Kind `polyline`, 2 or more vertices |
| One drawing session produces | **One object per segment** | **One object** for the whole path |
| DXF equivalent | `LINE` (already imported as `line`) | `LWPOLYLINE` / `POLYLINE` |
| Selecting / deleting | Each segment on its own | The whole path at once |

Why both exist: construction operations (trim, extend, offset, fillet, perpendicular/parallel
lines…) act on individual segments; imported DXF `LINE` entities must keep their identity so that
export can write them back as `LINE`.

## 2. Drawing (AutoCAD `LINE` behaviour)

1. Click the **start point**.
2. Each following click creates a **segment** from the previous point to the clicked point, stored
   immediately as its own Line object. The new point becomes the start of the next segment, so the
   segments form a chain.
3. A dashed preview runs from the current start point to the cursor.
4. End the chain with **Enter**, **right-click** or **Esc**. Segments already created are kept.
5. With no chain in progress, **Esc** returns to Select (as for every drawing tool).

## 3. Undo while drawing

- **Backspace** removes the **last segment created** in the current chain (it is deleted from the
  drawing) and moves the chain back to that segment's start. Repeating it walks back further.
- With only the start point placed, Backspace removes the start point.
- Segments of an ended chain are not affected; delete them as any other object.

## 4. Rejected input

- A click on the current start point (zero-length segment), including the second click of a
  double-click, creates nothing and keeps the chain going.
- Double-click does **not** zoom while the Line tool is active.

## 5. Typed coordinates

Coordinates typed in the command line act exactly like clicks (absolute `E,N`, relative `@dx,dy`,
polar `@dist<angle`); they are never snapped.

## 6. Snapping

Every snap mode of [snapping-spec.md](snapping-spec.md) applies to every click. **Perpendicular**
is available once the start point is placed; its reference point is the current start point (the
end of the last segment).

## 7. Display and selection

- A Line looks like a Polyline segment on the map and is selected, highlighted, hovered, menued and
  deleted like any other object (selection spec). Its handles are its two endpoints.
- The status bar and Properties name it **Line**.
