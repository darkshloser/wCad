// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Selection rules from knowledge/selection-spec.md, free of OpenLayers and the DOM.
 *
 * The engine only gathers facts (what was hit, which modifier keys were down, where the drag
 * started and ended) and asks this module what the new selection is. Keeping the rules here
 * means every row of the spec's tables is a unit test, not a manual check in a browser.
 */

/** Movement below this many pixels is a click; at or above it, a rectangle drag (spec §3). */
export const DRAG_THRESHOLD_PX = 4;

/** How a gesture combines with the existing selection (spec §3.1, §3.2). */
export type SelectionModifier = 'replace' | 'add' | 'remove';

/** Window: left→right, fully inside. Crossing: right→left, anything touched (spec §3.2). */
export type RectMode = 'window' | 'crossing';

export type Extent = readonly [number, number, number, number];

export function modifierFrom(keys: { shiftKey: boolean; ctrlKey: boolean; metaKey?: boolean }): SelectionModifier {
  // Ctrl is checked first: with both held, removing is the safer reading. Cmd counts as Ctrl on macOS.
  if (keys.ctrlKey || keys.metaKey) return 'remove';
  if (keys.shiftKey) return 'add';
  return 'replace';
}

export function isDrag(start: readonly [number, number], current: readonly [number, number]): boolean {
  return Math.hypot(current[0] - start[0], current[1] - start[1]) >= DRAG_THRESHOLD_PX;
}

/** Direction decides the mode, measured in screen pixels, so it does not depend on the CRS. */
export function rectMode(startX: number, endX: number): RectMode {
  return endX >= startX ? 'window' : 'crossing';
}

/** The rectangle spanned by two corners, as [minX, minY, maxX, maxY]. */
export function normalizeRect(a: readonly [number, number], b: readonly [number, number]): Extent {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** True when `inner` lies entirely within `outer` (edges inclusive). */
export function extentContains(outer: Extent, inner: Extent): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

/** Combines a set of ids produced by a gesture with the current selection. */
export function applySelection(
  current: ReadonlySet<string>,
  ids: Iterable<string>,
  modifier: SelectionModifier,
): Set<string> {
  if (modifier === 'replace') return new Set(ids);
  const next = new Set(current);
  for (const id of ids) {
    if (modifier === 'add') next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * A single click (spec §3.1).
 *
 * Plain click on empty space clears everything; with Shift or Ctrl held it changes nothing, so a
 * slightly missed modifier-click never throws away a selection that took effort to build.
 */
export function clickSelection(
  current: ReadonlySet<string>,
  hitId: string | null,
  modifier: SelectionModifier,
): Set<string> {
  if (hitId === null) return modifier === 'replace' ? new Set() : new Set(current);
  return applySelection(current, [hitId], modifier);
}

/**
 * Right-click (spec §4): an already-selected object keeps the selection as it is; an unselected
 * one becomes the only selection; empty space changes nothing.
 */
export function contextMenuSelection(current: ReadonlySet<string>, hitId: string | null): Set<string> {
  if (hitId === null || current.has(hitId)) return new Set(current);
  return new Set([hitId]);
}

export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** What a right-click does (spec §4, §4.1, §6). */
export type RightClickDecision =
  | { readonly kind: 'finish-shape' }
  | { readonly kind: 'object-menu'; readonly elementId: string; readonly selection: Set<string> }
  | { readonly kind: 'view-menu'; readonly selection: Set<string> };

/**
 * Decides a right-click.
 *
 * Mid-shape in Polyline/Polygon, right-click finishes the shape (like Enter). Otherwise an object
 * under the pointer opens the object menu in every tool, and empty space opens the view menu. Only
 * Select changes the selection on right-click; Pan and the drawing tools never select.
 */
export function rightClickDecision(
  ctx: { readonly tool: string; readonly sketching: boolean },
  hitId: string | null,
  current: ReadonlySet<string>,
): RightClickDecision {
  if (ctx.sketching && (ctx.tool === 'line' || ctx.tool === 'polygon')) return { kind: 'finish-shape' };
  if (hitId !== null) {
    const selection = ctx.tool === 'select' ? contextMenuSelection(current, hitId) : new Set(current);
    return { kind: 'object-menu', elementId: hitId, selection };
  }
  return { kind: 'view-menu', selection: new Set(current) };
}
