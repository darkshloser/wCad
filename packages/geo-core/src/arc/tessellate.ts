// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { Coord2 } from '../types.ts';
import { type Arc, pointAtAngle, sweepAngle, validateArc } from './arc.ts';

/**
 * Adaptive arc tessellation.
 *
 * Segment count is derived from the sagitta (maximum deviation between chord and arc) so that
 * the visual error never exceeds `tolerance` in the same units as the radius. Callers on the
 * render path should pass a tolerance derived from the current pixel size, and cache the result
 * per zoom bucket — re-tessellating every frame is one of the easiest ways to lose the frame
 * budget on a large drawing.
 */

export const MAX_SEGMENTS = 4096;

/** Number of chords needed to keep the sagitta within `tolerance`. */
export function segmentCount(arc: Arc, tolerance: number): number {
  validateArc(arc);
  if (!(tolerance > 0)) throw new Error(`Tessellation tolerance must be > 0, got ${tolerance}`);
  const sweep = Math.abs(sweepAngle(arc));
  if (tolerance >= arc.radius) return Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
  const maxStep = 2 * Math.acos(1 - tolerance / arc.radius);
  return Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(sweep / maxStep)));
}

/** Maximum sagitta deviation produced by splitting the arc into `n` equal chords. */
export function sagittaError(arc: Arc, n: number): number {
  const step = Math.abs(sweepAngle(arc)) / n;
  return arc.radius * (1 - Math.cos(step / 2));
}

/**
 * Tessellate to a polyline. The first and last points are computed from the exact start and end
 * angles, so arc endpoints survive tessellation bit-exactly and remain valid snap targets.
 */
export function tessellate(arc: Arc, tolerance: number): Coord2[] {
  const n = segmentCount(arc, tolerance);
  const sweep = sweepAngle(arc);
  const out: Coord2[] = new Array(n + 1);
  out[0] = pointAtAngle(arc, arc.startAngle);
  for (let i = 1; i < n; i++) {
    out[i] = pointAtAngle(arc, arc.startAngle + (sweep * i) / n);
  }
  out[n] = pointAtAngle(arc, arc.endAngle);
  return out;
}
