// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { Coord2 } from '../types.ts';

/**
 * True CAD arcs (architecture doc section 10).
 *
 * OpenLayers has no native arc geometry. We store the canonical parametric definition so that
 * precision survives transforms and edits, and tessellate only for display and for export
 * formats that cannot represent true arcs. Never store tessellated output as the source of truth.
 */

export const TAU = Math.PI * 2;

export interface Arc {
  readonly center: Coord2;
  readonly radius: number;
  /** Radians, measured from +X axis. */
  readonly startAngle: number;
  readonly endAngle: number;
  /** Counter-clockwise sweep from startAngle to endAngle. */
  readonly ccw: boolean;
}

export function validateArc(arc: Arc): void {
  if (!Number.isFinite(arc.radius) || arc.radius <= 0) {
    throw new Error(`Arc radius must be a positive finite number, got ${arc.radius}`);
  }
  if (!Number.isFinite(arc.startAngle) || !Number.isFinite(arc.endAngle)) {
    throw new Error('Arc angles must be finite');
  }
  if (!Number.isFinite(arc.center[0]) || !Number.isFinite(arc.center[1])) {
    throw new Error('Arc center must be finite');
  }
}

/**
 * Signed sweep in radians: positive when ccw, negative otherwise.
 * A closed arc (startAngle === endAngle) is a full circle, sweeping the full TAU.
 */
export function sweepAngle(arc: Arc): number {
  const raw = arc.endAngle - arc.startAngle;
  if (arc.ccw) {
    let d = raw % TAU;
    if (d <= 0) d += TAU;
    return d;
  }
  let d = raw % TAU;
  if (d >= 0) d -= TAU;
  return d;
}

/** Point at parameter t in [0, 1] along the sweep. t=0 and t=1 hit the endpoints exactly. */
export function pointAt(arc: Arc, t: number): Coord2 {
  const angle = t === 1 ? arc.endAngle : arc.startAngle + sweepAngle(arc) * t;
  return pointAtAngle(arc, angle);
}

export function pointAtAngle(arc: Arc, angle: number): Coord2 {
  return [arc.center[0] + arc.radius * Math.cos(angle), arc.center[1] + arc.radius * Math.sin(angle)];
}

export function startPoint(arc: Arc): Coord2 {
  return pointAtAngle(arc, arc.startAngle);
}

export function endPoint(arc: Arc): Coord2 {
  return pointAtAngle(arc, arc.endAngle);
}

export function midPoint(arc: Arc): Coord2 {
  return pointAtAngle(arc, arc.startAngle + sweepAngle(arc) / 2);
}

export function arcLength(arc: Arc): number {
  return Math.abs(sweepAngle(arc)) * arc.radius;
}

/** True when `angle` lies on the arc's swept range. */
export function angleWithinArc(arc: Arc, angle: number): boolean {
  const sweep = sweepAngle(arc);
  let d = (angle - arc.startAngle) % TAU;
  if (arc.ccw) {
    if (d < 0) d += TAU;
    return d <= sweep + 1e-12;
  }
  if (d > 0) d -= TAU;
  return d >= sweep - 1e-12;
}

/** Axis-aligned bounding box, accounting for the cardinal extremes the arc actually crosses. */
export function arcBBox(arc: Arc): readonly [number, number, number, number] {
  const pts: Coord2[] = [startPoint(arc), endPoint(arc)];
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    if (angleWithinArc(arc, a)) pts.push(pointAtAngle(arc, a));
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return [minX, minY, maxX, maxY];
}

/** Three-point arc construction (start, a point on the arc, end) — a standard CAD tool. */
export function arcFrom3Points(p1: Coord2, p2: Coord2, p3: Coord2): Arc {
  const ax = p1[0];
  const ay = p1[1];
  const bx = p2[0];
  const by = p2[1];
  const cx = p3[0];
  const cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) throw new Error('Three-point arc: points are collinear or coincident');
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const center: Coord2 = [ux, uy];
  const radius = Math.hypot(ax - ux, ay - uy);
  const startAngle = Math.atan2(ay - uy, ax - ux);
  const midAngle = Math.atan2(by - uy, bx - ux);
  const endAngle = Math.atan2(cy - uy, cx - ux);
  // The sweep direction is whichever one passes through the middle point.
  const ccwCandidate: Arc = { center, radius, startAngle, endAngle, ccw: true };
  const ccw = angleWithinArc(ccwCandidate, midAngle);
  return { center, radius, startAngle, endAngle, ccw };
}
