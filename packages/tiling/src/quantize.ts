// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { BBox, Coord2 } from '@wcad/geo-core';

/**
 * MVT coordinate quantization.
 *
 * The Mapbox Vector Tile specification stores geometry as integers on a grid (conventionally
 * 4096 x 4096 per tile), so tile coordinates are approximate BY CONSTRUCTION. This module exists
 * mostly so that fact is explicit and testable rather than folklore.
 *
 * This is exactly why principle P1 exists: tiles drive the backdrop only. Anything edited,
 * measured or snapped to comes from the authoritative float64 geometry instead.
 */

export const MVT_EXTENT = 4096;

/** Worst-case positional error introduced by quantizing into a tile, in CRS units. */
export function quantizationError(tileSizeCrsUnits: number, extent = MVT_EXTENT): number {
  return tileSizeCrsUnits / extent / 2;
}

export function quantize(point: Coord2, tileBBox: BBox, extent = MVT_EXTENT): readonly [number, number] {
  const w = tileBBox[2] - tileBBox[0];
  const h = tileBBox[3] - tileBBox[1];
  const qx = Math.round(((point[0] - tileBBox[0]) / w) * extent);
  // MVT y grows downward from the tile's top edge.
  const qy = Math.round(((tileBBox[3] - point[1]) / h) * extent);
  return [clamp(qx, 0, extent), clamp(qy, 0, extent)];
}

/** Inverse of `quantize`. Lossy — for tests and debugging, never for the edit path. */
export function dequantize(q: readonly [number, number], tileBBox: BBox, extent = MVT_EXTENT): Coord2 {
  const w = tileBBox[2] - tileBBox[0];
  const h = tileBBox[3] - tileBBox[1];
  return [tileBBox[0] + (q[0] / extent) * w, tileBBox[3] - (q[1] / extent) * h];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
