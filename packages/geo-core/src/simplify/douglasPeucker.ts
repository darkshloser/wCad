// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import type { Coord2 } from '../types.ts';

/**
 * Douglas-Peucker generalization for the LOD pyramid (architecture doc sections 4.3, 5).
 *
 * This implementation is the shared definition: the Python workers must produce byte-identical
 * output for the same input and tolerance, verified by a cross-implementation test. If client
 * and server generalize differently, the backdrop and the working set disagree visually and
 * users lose trust in the drawing.
 *
 * Iterative (explicit stack) rather than recursive, so a multi-million-vertex polyline cannot
 * blow the call stack.
 */

/** LOD tolerance ladder matching the geom_lod1..3 columns, in CRS units (metres). */
export const LOD_TOLERANCES = [1, 10, 100] as const;

function perpendicularDistance(p: Coord2, a: Coord2, b: Coord2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  // Distance to the infinite line, which is what Douglas-Peucker is defined against.
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / Math.sqrt(len2);
}

export function simplify(points: readonly Coord2[], tolerance: number): Coord2[] {
  if (!(tolerance > 0)) return points.map((p) => [p[0], p[1]] as Coord2);
  if (points.length <= 2) return points.map((p) => [p[0], p[1]] as Coord2);

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let maxDist = -1;
    let index = -1;
    const a = points[first]!;
    const b = points[last]!;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i]!, a, b);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance && index > first) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Coord2[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i] === 1) out.push([points[i]![0], points[i]![1]]);
  }
  return out;
}

/** Builds the full LOD ladder for one geometry in a single pass over the tolerances. */
export function buildLodPyramid(points: readonly Coord2[]): Coord2[][] {
  return LOD_TOLERANCES.map((t) => simplify(points, t));
}
