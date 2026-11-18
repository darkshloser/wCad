// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * The central snapping engine (knowledge/snapping-spec.md v2), free of OpenLayers and the DOM.
 *
 * Every drawing tool uses this one function: give it the exact geometry around the cursor, the
 * enabled modes and the reference point, and it returns the single active target or null. Each
 * mode is its own small generator, so adding one (Quadrant, Tangent, …) touches nothing else.
 *
 * Everything works in the drawing's CRS on the stored float64 coordinates. Arcs and circles use
 * their true curve, never the tessellated display line — a "nearest" point on the tessellation
 * would sit slightly off the real arc, and the error would be invisible until someone measured it.
 */

import {
  type Arc,
  type ElementKind,
  angleWithinArc,
  arcArcIntersections,
  midPoint as arcMidPoint,
  segmentArcIntersections,
  segmentSegmentIntersection,
} from '@wcad/geo-core';
import type { ElementRecord } from '@wcad/store-contract';

/** Snap distance in screen pixels, the same at every zoom (spec §3). */
export const SNAP_DISTANCE_PX = 10;

/** All modes, in priority order (spec §3): earlier wins whenever it has a candidate in range. */
export const SNAP_MODES = ['endpoint', 'midpoint', 'centre', 'intersection', 'perpendicular', 'nearest'] as const;
export type SnapMode = (typeof SNAP_MODES)[number];

export const SNAP_MODE_LABEL: Readonly<Record<SnapMode, string>> = {
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  centre: 'Centre',
  intersection: 'Intersection',
  perpendicular: 'Perpendicular',
  nearest: 'Nearest',
};

/** Defaults (spec §1). Nearest is off: it is almost always in range and hides precise snaps. */
export const DEFAULT_SNAP_MODES: ReadonlySet<SnapMode> = new Set<SnapMode>([
  'endpoint',
  'midpoint',
  'centre',
  'intersection',
]);

/** Perpendicular needs a reference vertex, which only Line, Polyline and Polygon have (spec §2). */
export function perpendicularAvailable(tool: string): boolean {
  return tool === 'line' || tool === 'polyline' || tool === 'polygon';
}

type XY = readonly [number, number];
type BBox = readonly [number, number, number, number];

/** Snap-relevant geometry of one stored object. */
export type SnapGeom =
  | { readonly type: 'point'; readonly id: string; readonly kind: ElementKind; readonly bbox: BBox; readonly p: XY }
  | {
      readonly type: 'path';
      readonly id: string;
      readonly kind: ElementKind;
      readonly bbox: BBox;
      /** Vertices; a polygon's closing duplicate is removed and `closed` set instead. */
      readonly pts: readonly XY[];
      readonly closed: boolean;
    }
  | {
      readonly type: 'curve';
      readonly id: string;
      readonly kind: ElementKind;
      readonly bbox: BBox;
      readonly arc: Arc;
      /** A circle: no endpoints, no midpoint. */
      readonly full: boolean;
      /** Stored start and end coordinates of an arc, used verbatim for Endpoint. */
      readonly ends: readonly XY[];
    };

export interface SnapTarget {
  readonly x: number;
  readonly y: number;
  readonly mode: SnapMode;
  readonly elementId: string;
  /** Kind of the object hit; a snapped Point object is drawn as a bigger dot. */
  readonly elementKind: ElementKind;
}

export interface SnapQuery {
  readonly cursor: XY;
  /** The snap distance converted to CRS units at the current zoom. */
  readonly tolerance: number;
  readonly modes: ReadonlySet<SnapMode>;
  /** Last placed vertex of the shape being drawn; null when Perpendicular is unavailable. */
  readonly reference: XY | null;
}

// ------------------------------------------------------------------------------------ building

/** Converts a stored record into snap geometry, or null when it offers nothing to snap to. */
export function snapGeomFrom(rec: ElementRecord): SnapGeom | null {
  const xy = (c: readonly number[]): XY => [c[0]!, c[1]!];
  const p = rec.params;

  if ((rec.kind === 'circle' || rec.kind === 'arc') && p && isNum(p['cx']) && isNum(p['cy']) && isNum(p['r'])) {
    const full = rec.kind === 'circle';
    const arc: Arc = full
      ? { center: [p['cx'], p['cy']], radius: p['r'], startAngle: 0, endAngle: 0, ccw: true }
      : {
          center: [p['cx'], p['cy']],
          radius: p['r'],
          startAngle: p['startAngle'] ?? 0,
          endAngle: p['endAngle'] ?? 0,
          ccw: p['ccw'] === 1,
        };
    const r = arc.radius;
    return {
      type: 'curve',
      id: rec.id,
      kind: rec.kind,
      // Conservative: the full circle's box. Only used to skip far objects quickly.
      bbox: [arc.center[0] - r, arc.center[1] - r, arc.center[0] + r, arc.center[1] + r],
      arc,
      full,
      ends: full || rec.coords.length === 0 ? [] : [xy(rec.coords[0]!), xy(rec.coords[rec.coords.length - 1]!)],
    };
  }

  if (rec.coords.length === 0) return null;

  if (rec.kind === 'point') {
    const pt = xy(rec.coords[0]!);
    return { type: 'point', id: rec.id, kind: rec.kind, bbox: [pt[0], pt[1], pt[0], pt[1]], p: pt };
  }

  if (rec.kind === 'polyline' || rec.kind === 'line' || rec.kind === 'polygon') {
    let pts = rec.coords.map(xy);
    const closed = rec.kind === 'polygon';
    if (closed && pts.length > 1 && same(pts[0]!, pts[pts.length - 1]!)) pts = pts.slice(0, -1);
    if (pts.length === 0) return null;
    return { type: 'path', id: rec.id, kind: rec.kind, bbox: boxOf(pts), pts, closed };
  }

  return null;
}

// ------------------------------------------------------------------------------------ query

interface Candidate {
  readonly x: number;
  readonly y: number;
  readonly d: number;
  readonly g: SnapGeom;
}

/**
 * The active target for a cursor position, or null (spec §3).
 *
 * Modes are tried in priority order and the first one with any candidate in range wins; within a
 * mode the nearest candidate wins, ties broken by object id and then coordinates so the answer is
 * the same on every run.
 */
export function findSnap(geoms: readonly SnapGeom[], q: SnapQuery): SnapTarget | null {
  const near = geoms.filter((g) => bboxDistance(g.bbox, q.cursor) <= q.tolerance);
  if (near.length === 0) return null;

  for (const mode of SNAP_MODES) {
    if (!q.modes.has(mode)) continue;
    if (mode === 'perpendicular' && !q.reference) continue;
    const best = pickNearest(GENERATORS[mode](near, q), q.tolerance);
    if (best) return { x: best.x, y: best.y, mode, elementId: best.g.id, elementKind: best.g.kind };
  }
  return null;
}

function pickNearest(cands: readonly Candidate[], tolerance: number): Candidate | null {
  let best: Candidate | null = null;
  for (const c of cands) {
    if (!(c.d <= tolerance)) continue;
    if (!best || c.d < best.d || (c.d === best.d && tieBreak(c, best) < 0)) best = c;
  }
  return best;
}

function tieBreak(a: Candidate, b: Candidate): number {
  return a.g.id.localeCompare(b.g.id) || a.x - b.x || a.y - b.y;
}

type Generator = (geoms: readonly SnapGeom[], q: SnapQuery) => Candidate[];

const GENERATORS: Readonly<Record<SnapMode, Generator>> = {
  endpoint(geoms, q) {
    const out: Candidate[] = [];
    for (const g of geoms) {
      const pts = g.type === 'point' ? [g.p] : g.type === 'path' ? g.pts : g.ends;
      for (const p of pts) out.push(cand(p, q.cursor, g));
    }
    return out;
  },

  midpoint(geoms, q) {
    const out: Candidate[] = [];
    for (const g of geoms) {
      if (g.type === 'path') {
        for (const [a, b] of segments(g)) out.push(cand([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], q.cursor, g));
      } else if (g.type === 'curve' && !g.full) {
        // Halfway ALONG the arc, not the chord's midpoint.
        out.push(cand(arcMidPoint(g.arc), q.cursor, g));
      }
    }
    return out;
  },

  centre(geoms, q) {
    return geoms.filter((g) => g.type === 'curve').map((g) => cand((g as { arc: Arc }).arc.center, q.cursor, g));
  },

  intersection(geoms, q) {
    // Only pieces passing within the snap distance can produce an intersection within it.
    const pieces: Piece[] = [];
    for (const g of geoms) {
      if (g.type === 'path') {
        segments(g).forEach(([a, b], i) => {
          if (distToSegment(q.cursor, a, b) <= q.tolerance) pieces.push({ g, seg: [a, b], index: i });
        });
      } else if (g.type === 'curve' && distToCurve(q.cursor, g) <= q.tolerance) {
        pieces.push({ g, arc: g.arc, index: 0 });
      }
    }
    const out: Candidate[] = [];
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i]!;
        const b = pieces[j]!;
        if (a.g === b.g && (a.arc || b.arc || adjacent(a.g, a.index, b.index))) continue;
        for (const p of intersect(a, b)) out.push(cand(p, q.cursor, a.g.id <= b.g.id ? a.g : b.g));
      }
    }
    return out;
  },

  perpendicular(geoms, q) {
    const ref = q.reference;
    if (!ref) return [];
    const out: Candidate[] = [];
    for (const g of geoms) {
      if (g.type === 'path') {
        for (const [a, b] of segments(g)) {
          const t = projectT(ref, a, b);
          if (t !== null && t >= 0 && t <= 1) out.push(cand(lerp(a, b, t), q.cursor, g));
        }
      } else if (g.type === 'curve') {
        const { center, radius } = g.arc;
        const dx = ref[0] - center[0];
        const dy = ref[1] - center[1];
        const len = Math.hypot(dx, dy);
        if (len === 0) continue; // every radius is perpendicular from the centre: undefined
        // Both points where the line through the centre meets the curve are perpendicular feet.
        for (const s of [1, -1]) {
          const p: XY = [center[0] + (s * radius * dx) / len, center[1] + (s * radius * dy) / len];
          if (g.full || angleWithinArc(g.arc, Math.atan2(p[1] - center[1], p[0] - center[0]))) {
            out.push(cand(p, q.cursor, g));
          }
        }
      }
    }
    return out;
  },

  nearest(geoms, q) {
    const out: Candidate[] = [];
    for (const g of geoms) {
      if (g.type === 'path') {
        for (const [a, b] of segments(g)) {
          const t = projectT(q.cursor, a, b);
          out.push(cand(t === null ? a : lerp(a, b, clamp01(t)), q.cursor, g));
        }
        if (g.pts.length === 1) out.push(cand(g.pts[0]!, q.cursor, g));
      } else if (g.type === 'curve') {
        const p = nearestOnCurve(q.cursor, g);
        if (p) out.push(cand(p, q.cursor, g));
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------------------------ geometry

interface Piece {
  readonly g: SnapGeom;
  readonly seg?: readonly [XY, XY];
  readonly arc?: Arc;
  readonly index: number;
}

function intersect(a: Piece, b: Piece): XY[] {
  if (a.seg && b.seg) {
    const p = segmentSegmentIntersection(a.seg[0], a.seg[1], b.seg[0], b.seg[1]);
    return p ? [p] : [];
  }
  if (a.seg && b.arc) return segmentArcIntersections(a.seg[0], a.seg[1], b.arc);
  if (a.arc && b.seg) return segmentArcIntersections(b.seg[0], b.seg[1], a.arc);
  if (a.arc && b.arc) return arcArcIntersections(a.arc, b.arc);
  return [];
}

/** Adjacent segments of the same path share a vertex; that is an Endpoint, not an Intersection. */
function adjacent(g: SnapGeom, i: number, j: number): boolean {
  if (g.type !== 'path') return false;
  const n = segmentCount(g);
  return Math.abs(i - j) === 1 || (g.closed && n > 2 && Math.abs(i - j) === n - 1) || i === j;
}

function segmentCount(g: Extract<SnapGeom, { type: 'path' }>): number {
  if (g.pts.length < 2) return 0;
  return g.closed && g.pts.length > 2 ? g.pts.length : g.pts.length - 1;
}

/** Segments of a path, including a polygon's closing segment. */
export function segments(g: Extract<SnapGeom, { type: 'path' }>): Array<readonly [XY, XY]> {
  const out: Array<readonly [XY, XY]> = [];
  const n = segmentCount(g);
  for (let i = 0; i < n; i++) out.push([g.pts[i]!, g.pts[(i + 1) % g.pts.length]!]);
  return out;
}

/** Parameter of the projection of p onto the line a→b, or null for a zero-length segment. */
function projectT(p: XY, a: XY, b: XY): number | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return null;
  return ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
}

/**
 * Point at parameter t on a→b. The endpoints are returned verbatim at t = 0 and t = 1, so a
 * projection that lands on a vertex reproduces the stored value rather than a rounded one.
 */
function lerp(a: XY, b: XY, t: number): XY {
  if (t === 0) return a;
  if (t === 1) return b;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function distToSegment(p: XY, a: XY, b: XY): number {
  const t = projectT(p, a, b);
  const q = t === null ? a : lerp(a, b, clamp01(t));
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/** Nearest point on the true curve; for an arc, the nearer end when the projection misses it. */
function nearestOnCurve(p: XY, g: Extract<SnapGeom, { type: 'curve' }>): XY | null {
  const { center, radius } = g.arc;
  const dx = p[0] - center[0];
  const dy = p[1] - center[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null; // every point is equally near: no single answer
  const angle = Math.atan2(dy, dx);
  if (g.full || angleWithinArc(g.arc, angle)) {
    return [center[0] + (radius * dx) / len, center[1] + (radius * dy) / len];
  }
  let best: XY | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const e of g.ends) {
    const d = Math.hypot(p[0] - e[0], p[1] - e[1]);
    if (d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

function distToCurve(p: XY, g: Extract<SnapGeom, { type: 'curve' }>): number {
  const q = nearestOnCurve(p, g);
  return q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : g.arc.radius;
}

function cand(p: XY, cursor: XY, g: SnapGeom): Candidate {
  return { x: p[0], y: p[1], d: Math.hypot(p[0] - cursor[0], p[1] - cursor[1]), g };
}

function bboxDistance(b: BBox, p: XY): number {
  const dx = Math.max(b[0] - p[0], 0, p[0] - b[2]);
  const dy = Math.max(b[1] - p[1], 0, p[1] - b[3]);
  return Math.hypot(dx, dy);
}

function boxOf(pts: readonly XY[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function same(a: XY, b: XY): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ------------------------------------------------------------------------------------ status

/** Status-bar text (spec §5, §8). */
export function snapStatusLabel(enabled: boolean, target: SnapTarget | null): string {
  if (!enabled) return 'SNAP OFF';
  return target ? `SNAP · ${SNAP_MODE_LABEL[target.mode].toLowerCase()}` : 'SNAP';
}

/** Snapping applies when switched on (F3) and Alt is not held (spec §8). */
export function snapActive(state: { readonly enabled: boolean; readonly altHeld: boolean }): boolean {
  return state.enabled && !state.altHeld;
}

// ------------------------------------------------------------------------------------ cache

/**
 * Geometry is fetched for a window larger than the snap distance and reused until the cursor
 * nears the window's edge or the data changes — lookups are asynchronous, but snapping must decide
 * synchronously on every pointer event.
 */
export const CACHE_RADIUS_PX = 150;
export const CACHE_REFRESH_MARGIN_PX = 40;

export function cacheCovers(window: BBox | null, cursor: XY, marginMapUnits: number): boolean {
  if (!window) return false;
  return (
    cursor[0] - marginMapUnits >= window[0] &&
    cursor[1] - marginMapUnits >= window[1] &&
    cursor[0] + marginMapUnits <= window[2] &&
    cursor[1] + marginMapUnits <= window[3]
  );
}
