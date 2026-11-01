// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { Coord2 } from '../types.ts';
import { type Arc, sweepAngle } from './arc.ts';

/**
 * DXF bulge <-> arc conversion.
 *
 * A DXF bulge is tan(theta / 4) where theta is the included angle of the arc, signed:
 * positive means counter-clockwise. bulge = 0 is a straight segment, bulge = 1 a semicircle.
 * This is the representation LWPOLYLINE uses, so it is on the DXF import/export hot path.
 */

export interface BulgeSegment {
  readonly p1: Coord2;
  readonly p2: Coord2;
  readonly bulge: number;
}

export function bulgeToArc(p1: Coord2, p2: Coord2, bulge: number): Arc {
  if (bulge === 0) throw new Error('bulgeToArc: bulge 0 describes a straight segment, not an arc');
  if (!Number.isFinite(bulge)) throw new Error(`bulgeToArc: bulge must be finite, got ${bulge}`);

  const theta = 4 * Math.atan(bulge); // signed included angle
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  if (dx === 0 && dy === 0) throw new Error('bulgeToArc: endpoints are coincident');

  // Offset from the chord midpoint to the arc centre, along the chord normal.
  const k = 0.5 / Math.tan(theta / 2);
  const center: Coord2 = [(p1[0] + p2[0]) / 2 - k * dy, (p1[1] + p2[1]) / 2 + k * dx];
  const radius = Math.hypot(p1[0] - center[0], p1[1] - center[1]);

  return {
    center,
    radius,
    startAngle: Math.atan2(p1[1] - center[1], p1[0] - center[0]),
    endAngle: Math.atan2(p2[1] - center[1], p2[0] - center[0]),
    ccw: bulge > 0,
  };
}

export function arcToBulge(arc: Arc): BulgeSegment {
  const sweep = sweepAngle(arc);
  return {
    p1: [arc.center[0] + arc.radius * Math.cos(arc.startAngle), arc.center[1] + arc.radius * Math.sin(arc.startAngle)],
    p2: [arc.center[0] + arc.radius * Math.cos(arc.endAngle), arc.center[1] + arc.radius * Math.sin(arc.endAngle)],
    bulge: Math.tan(sweep / 4),
  };
}
