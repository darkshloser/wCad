// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Tool behaviour that does not depend on OpenLayers.
 *
 * Kept free of map and DOM imports so the rules each tool enforces — what a valid drawn shape is,
 * which vertices a selection marks, what the status line tells the user — are unit-tested
 * directly rather than only through a browser.
 */

import type { ElementKind } from '@wcad/geo-core';

export type ToolName = 'pan' | 'select' | 'point' | 'line' | 'polygon' | 'circle' | 'arc3';

/** The tool active when the app opens (knowledge/selection-spec.md §1). */
export const DEFAULT_TOOL: ToolName = 'pan';

/** Drawing tools: clicks create objects and never select (spec §6). */
export function isDrawingTool(tool: ToolName): boolean {
  return tool !== 'pan' && tool !== 'select';
}

type XY = readonly [number, number] | readonly number[];

/** Step-by-step guidance shown in the status bar when a tool is activated. */
export const TOOL_GUIDE: Record<ToolName, string> = {
  pan: 'Pan: drag to move the map, wheel to zoom.',
  select:
    'Select (read-only): click an object, or drag a rectangle — left→right selects objects fully inside, ' +
    'right→left selects anything touched. Shift adds, Ctrl removes. Right-click for the menu, Del deletes, Esc clears.',
  point: 'Point: click to place a point, or type a coordinate. Each click places another. Esc to stop.',
  line:
    'Polyline: click each vertex, double-click or Enter to finish. ' +
    'Backspace removes the last vertex, Esc cancels.',
  polygon:
    'Polygon: click each vertex (at least 3), click the first vertex, double-click or Enter to close. ' +
    'Backspace removes the last vertex, Esc cancels.',
  circle: 'Circle: click the centre, then click a point on the circle to set the radius. Esc cancels.',
  arc3: 'Arc: click the start point, a point on the arc, then the end point. Backspace undoes a point, Esc cancels.',
};

/** Minimum distinct vertices for a drawn shape to be stored. */
const MIN_DISTINCT: Partial<Record<ElementKind, number>> = { line: 2, polyline: 2, polygon: 3 };

/** Drops consecutive repeated vertices, such as the one a double-click finish leaves behind. */
export function dedupeConsecutive<T extends XY>(coords: readonly T[]): T[] {
  const out: T[] = [];
  for (const p of coords) {
    const prev = out[out.length - 1];
    if (!prev || !samePoint(prev, p)) out.push(p);
  }
  return out;
}

/**
 * Counts vertices that differ from their predecessor.
 *
 * A double-click finishes a line by clicking the same spot twice, and a polygon ring repeats its
 * first vertex to close; neither duplicate makes the shape any less degenerate.
 */
export function distinctVertexCount(coords: readonly XY[], closed = false): number {
  const pts = closed && coords.length > 1 && samePoint(coords[0]!, coords[coords.length - 1]!)
    ? coords.slice(0, -1)
    : coords;
  let count = 0;
  let prev: XY | null = null;
  for (const p of pts) {
    if (!prev || !samePoint(prev, p)) count++;
    prev = p;
  }
  return count;
}

/**
 * Returns why a drawn shape cannot be stored, or null when it is valid.
 *
 * Rejecting here rather than storing and repairing later keeps zero-length lines and collapsed
 * polygons out of the database, where they would become invalid geometry for every consumer.
 */
export function drawnShapeProblem(kind: ElementKind, coords: readonly XY[], radius?: number): string | null {
  if (kind === 'circle') {
    return radius !== undefined && radius > 0 && Number.isFinite(radius) ? null : 'Circle needs a radius greater than zero.';
  }
  const min = MIN_DISTINCT[kind];
  if (min === undefined) return null;
  const distinct = distinctVertexCount(coords, kind === 'polygon');
  if (distinct < min) {
    const label = kind === 'polygon' ? 'Polygon' : 'Polyline';
    return `${label} needs at least ${min} distinct vertices (got ${distinct}).`;
  }
  return null;
}

/**
 * The vertices a selected object marks with handles.
 *
 * Arcs are drawn as a tessellated line, but their real vertices are only start and end — marking
 * every tessellation point would show the user dozens of "vertices" that do not exist. Circles
 * mark their centre. A polygon ring's closing vertex duplicates the first and is dropped.
 */
export function selectionVertices(
  kind: ElementKind,
  drawn: readonly XY[],
  center?: readonly [number, number],
): Array<[number, number]> {
  const xy = (p: XY): [number, number] => [p[0]!, p[1]!];
  switch (kind) {
    case 'point':
    case 'text':
    case 'insert':
      return [];
    case 'circle':
      return center ? [[center[0], center[1]]] : [];
    case 'arc':
      if (drawn.length === 0) return [];
      return drawn.length === 1 ? [xy(drawn[0]!)] : [xy(drawn[0]!), xy(drawn[drawn.length - 1]!)];
    case 'polygon': {
      const ring = drawn.length > 1 && samePoint(drawn[0]!, drawn[drawn.length - 1]!) ? drawn.slice(0, -1) : drawn;
      return ring.map(xy);
    }
    default:
      return drawn.map(xy);
  }
}

function samePoint(a: XY, b: XY): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Keys the map reacts to. Ignored while the user is typing in a field. */
export type KeyAction = 'finish' | 'cancel' | 'undo-vertex' | 'delete' | null;

export function keyAction(key: string, targetTag: string | undefined): KeyAction {
  const tag = (targetTag ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return null;
  // Esc still cancels from the coordinate field; Enter and Backspace belong to the field there.
  if (key === 'Escape') return 'cancel';
  if (tag === 'INPUT') return null;
  if (key === 'Enter') return 'finish';
  if (key === 'Backspace') return 'undo-vertex';
  if (key === 'Delete') return 'delete';
  return null;
}
