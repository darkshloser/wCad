// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import type { Coord2 } from '../types.ts';
import { type Arc, angleWithinArc } from './arc.ts';

/**
 * Intersection primitives backing the CAD snap modes (intersection, perpendicular, tangent).
 *
 * These operate on authoritative float64 geometry only. Snapping against tessellated or tiled
 * geometry would violate P1 and silently corrupt drawings.
 */

const EPS = 1e-10;

/** Intersections of an infinite line through a and b with a circle. */
export function lineCircleIntersections(
  a: Coord2,
  b: Coord2,
  center: Coord2,
  radius: number,
): Coord2[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return [];
  const fx = a[0] - center[0];
  const fy = a[1] - center[1];
  const bq = 2 * (fx * dx + fy * dy);
  const cq = fx * fx + fy * fy - radius * radius;
  const disc = bq * bq - 4 * len2 * cq;
  if (disc < -EPS) return [];
  if (Math.abs(disc) <= EPS) {
    const t = -bq / (2 * len2);
    return [[a[0] + t * dx, a[1] + t * dy]];
  }
  const sq = Math.sqrt(disc);
  const t1 = (-bq - sq) / (2 * len2);
  const t2 = (-bq + sq) / (2 * len2);
  return [
    [a[0] + t1 * dx, a[1] + t1 * dy],
    [a[0] + t2 * dx, a[1] + t2 * dy],
  ];
}

export function circleCircleIntersections(
  c1: Coord2,
  r1: number,
  c2: Coord2,
  r2: number,
): Coord2[] {
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  if (d < EPS) return []; // concentric (identical circles yield infinite solutions)
  if (d > r1 + r2 + EPS) return [];
  if (d < Math.abs(r1 - r2) - EPS) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 <= 0 ? 0 : Math.sqrt(h2);
  const mx = c1[0] + (a * dx) / d;
  const my = c1[1] + (a * dy) / d;
  if (h === 0) return [[mx, my]];
  const rx = (-dy * h) / d;
  const ry = (dx * h) / d;
  return [
    [mx + rx, my + ry],
    [mx - rx, my - ry],
  ];
}

function onArc(arc: Arc, p: Coord2): boolean {
  return angleWithinArc(arc, Math.atan2(p[1] - arc.center[1], p[0] - arc.center[0]));
}

function withinSegment(a: Coord2, b: Coord2, p: Coord2): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return false;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  return t >= -EPS && t <= 1 + EPS;
}

export function segmentArcIntersections(a: Coord2, b: Coord2, arc: Arc): Coord2[] {
  return lineCircleIntersections(a, b, arc.center, arc.radius).filter(
    (p) => onArc(arc, p) && withinSegment(a, b, p),
  );
}

export function arcArcIntersections(a1: Arc, a2: Arc): Coord2[] {
  return circleCircleIntersections(a1.center, a1.radius, a2.center, a2.radius).filter(
    (p) => onArc(a1, p) && onArc(a2, p),
  );
}

/** Intersection of two line segments, or null when they do not cross. */
export function segmentSegmentIntersection(
  a1: Coord2,
  a2: Coord2,
  b1: Coord2,
  b2: Coord2,
): Coord2 | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < EPS) return null; // parallel or degenerate
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denom;
  const u = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return [a1[0] + t * d1x, a1[1] + t * d1y];
}
