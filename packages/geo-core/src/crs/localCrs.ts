// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import type { Coord2, Coord3, LocalCrsParams } from '../types.ts';

/**
 * Local / site engineering coordinate systems.
 *
 * Forward (local -> base):  P = origin + R(rot) * (scale * p)
 * Inverse (base -> local):  p = R(-rot) * (P - origin) / scale
 *
 * Pure float64 math with no external dependency, so it is exhaustively property-testable.
 */

export function localToBase(p: Coord2, params: LocalCrsParams): Coord2 {
  const { origin, rotation, scale } = params;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const x = p[0] * scale;
  const y = p[1] * scale;
  return [origin[0] + x * c - y * s, origin[1] + x * s + y * c];
}

export function baseToLocal(p: Coord2, params: LocalCrsParams): Coord2 {
  const { origin, rotation, scale } = params;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const dx = p[0] - origin[0];
  const dy = p[1] - origin[1];
  return [(dx * c + dy * s) / scale, (-dx * s + dy * c) / scale];
}

export function localToBase3(p: Coord3, params: LocalCrsParams): Coord3 {
  const [x, y] = localToBase([p[0], p[1]], params);
  return [x, y, p[2] + params.heightOffset];
}

export function baseToLocal3(p: Coord3, params: LocalCrsParams): Coord3 {
  const [x, y] = baseToLocal([p[0], p[1]], params);
  return [x, y, p[2] - params.heightOffset];
}

/** Validates parameters that would make the transform non-invertible. */
export function validateLocalCrs(params: LocalCrsParams): void {
  if (!Number.isFinite(params.scale) || params.scale === 0) {
    throw new Error(`Local CRS scale must be a non-zero finite number, got ${params.scale}`);
  }
  if (!Number.isFinite(params.rotation)) {
    throw new Error(`Local CRS rotation must be finite, got ${params.rotation}`);
  }
  if (!Number.isFinite(params.origin[0]) || !Number.isFinite(params.origin[1])) {
    throw new Error('Local CRS origin must be finite');
  }
}
