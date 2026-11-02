# Selection mechanism — specification

Status: **agreed with the product owner; implemented** in `apps/web/src/map/selection.ts` (rules,
unit-tested in `apps/web/test/selection.test.ts`) and `apps/web/src/map/engine.ts` (wiring), with
browser tests in `apps/web/e2e/tools.spec.ts`.
Scope: the web client (`apps/web`), the toolbar tools **Pan**, **Select** and the drawing tools.

This document is the source of truth for how selection behaves. If the code and this spec disagree,
the code is wrong unless this spec is updated first.

---

## 1. Toolbar

| Tool | Notes |
|---|---|
| **Pan** (hand icon) | **New. First in the toolbar and the default tool when the app opens.** |
| **Select** | Read-only selection (see §3). |
| Point, Polyline, Polygon, Circle, Arc (3 pt) | Drawing tools (see §6). |

## 2. Pan tool

- Left-drag moves the map.
- A click does nothing: it never selects or deselects.
- Cursor: open hand; closed hand while dragging.
- The mouse wheel zooms in **every** tool.

## 3. Select tool

Select is **read-only**. Nothing in Select mode moves, drags or reshapes an object's geometry.

A press-and-release is a **click** when the pointer moved less than **~4 px**. Beyond that it is a
**drag**, which draws a selection rectangle.

### 3.1 Single click

| Action | Result |
|---|---|
| Click an object | All other objects are deselected; only the clicked object is selected. |
| **Shift**+click an object | The object is **added** to the selection. |
| **Ctrl**+click a selected object | The object is **removed** from the selection. |
| Click empty space | **All** objects are deselected. |
| Shift/Ctrl+click empty space | No change. |

### 3.2 Selection rectangle (left button down, move > ~4 px)

The rectangle is drawn from the press point to the current pointer position and follows the mouse.

| Drag direction | Appearance | Selects on release |
|---|---|---|
| **Left → right** (window) | **Dashed white** rectangle | Only objects **fully inside** the rectangle |
| **Right → left** (crossing) | **Dotted white** rectangle | Any object the rectangle **touches** (intersects or contains) |

- Both rectangles get a thin dark outline so the white line stays visible on light backgrounds.
- No modifier: the result **replaces** the selection, so an empty rectangle deselects everything.
- **Shift**: the result is **added** to the selection.
- **Ctrl**: the result is **removed** from the selection.
- The rectangle **disappears** when the button is released.
- The map **never pans** while dragging in Select mode.
- **Esc** during a drag cancels it and leaves the selection unchanged.

### 3.3 Hover

- Light blue outline on the object under the mouse, **in every tool** (Pan, Select and drawing
  tools), so the user can see which object a right-click will act on.
- In Select the cursor also becomes a pointer; Pan keeps the hand, drawing tools the crosshair.
- Preview only: hover **never** changes the selection.

### 3.4 Highlight

- Every selected object is shown with the selection highlight: orange outline over a white halo,
  plus markers on its real vertices (arc: start and end only; circle: centre).
- Snap markers are not selection and must never look like it (see §6).

## 4. Right-click menu and Properties

- The properties panel **never opens automatically** when objects are selected.
- It opens only from **right-click → Properties**.
- Right-clicking an object **always opens the menu, in every tool** (Pan, Select and drawing tools).
  The one exception: in Polyline/Polygon while a shape is being drawn, right-click finishes the
  shape instead (§6).
- While the menu is open, the object it acts on is shown with the hover highlight, so it is clear
  which object the menu belongs to.

### In Select

| Right-click on… | Selection | Menu |
|---|---|---|
| An object that is **already selected** | Unchanged | Opens; acts on the right-clicked object |
| An **unselected** object | Only that object becomes selected | Opens; acts on that object |
| Empty space | Unchanged | **View menu** (§4.1) |

### In Pan and the drawing tools

| Right-click on… | Selection | Menu |
|---|---|---|
| Any object | Unchanged (these tools never select, §2 and §6) | Opens; acts on the right-clicked object |
| Empty space | Unchanged | **View menu** (§4.1) |

Object menu items:

- **Properties** — shows the right-clicked object.
- **Delete** — removes **only the right-clicked object**. The rest of the selection stays selected.

### 4.1 View menu (right-click on empty space)

Settings for how the application itself is displayed. Opens in every tool, except while a
Polyline/Polygon shape is in progress (then right-click finishes the shape, §6).

| Item | Effect |
|---|---|
| **Basemap** (on/off) | Shows or hides the OpenStreetMap background. Kept in sync with the toolbar checkbox. |
| **Background: Dark / Light** | Switches the drawing-area background colour. Default: Dark. |
| **Performance readout** (on/off) | Shows or hides the fps / tile / memory numbers in the status bar. Default: on. |

- Choosing an item applies it immediately and closes the menu.
- These settings are **remembered per browser** and restored when the app is reopened. If the saved
  settings are missing or unreadable, the defaults are used.
- The view menu never changes the selection.

### 4.2 Closing a menu

- Left-click anywhere on the map, Esc, or choosing an item closes the menu.

## 5. Keyboard

| Key | Context | Result |
|---|---|---|
| **Delete** | Select mode, at least one object selected | Removes **all selected objects**. |
| **Esc** | Select mode | Deselects everything (or cancels a rectangle drag in progress). |
| **Esc** | Drawing tool | Cancels the shape in progress; a second Esc returns to Select. |

Keys are ignored while the user is typing in a field (coordinate box, metadata editor), except Esc
in the coordinate box.

## 6. Things that must never change the selection

- Zooming (wheel), panning, moving the mouse.
- The map reloading its objects after a pan or zoom.
- A selection survives pan and zoom, including when the selected objects are off screen.

### Drawing tools

- Clicks create objects and **never** select anything; nothing is left highlighted after creating.
- Switching to a drawing tool clears the selection.
- Snap candidates are **not** drawn as markers. Only the single active snap target under the cursor
  is shown, and only while a drawing tool is active. (The previous gold markers on nearby vertices
  were mistaken for a random selection.)
- In drawing tools left-drag still pans, so the user can move around while drawing.
- In Polyline/Polygon, right-click while a shape is in progress finishes it (like Enter). With no
  shape in progress, right-click on an object opens the menu (§4).

## 7. Out of scope

- Only working-set objects (drawn in the app) are selectable. Imported backdrop (tile) objects
  become selectable in Phase 4, when they are promoted through the exact-geometry API.
- Moving or editing geometry: a separate, explicit tool in Phase 4, never a side effect of Select.
