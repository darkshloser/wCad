// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { LOD_TOLERANCES } from '@wcad/geo-core';
import type { BBox } from '@wcad/geo-core';
import { type TileScheme, resolution } from './scheme.ts';

/**
 * Level-of-detail selection (architecture doc sections 4.3 and 5).
 *
 * `geom_lod1..3` are pre-generalized at import time with the tolerances in LOD_TOLERANCES.
 * Level 0 means the authoritative `geom` column: exact, never generalized.
 *
 * Selection is driven by an error budget of half a pixel. Generalizing more aggressively than
 * that is invisible on screen and free; generalizing less wastes bandwidth and GPU time on
 * vertices that collapse into the same pixel.
 */

export type LodLevel = 0 | 1 | 2 | 3;

/** Column name for a level, so the SQL builder never hardcodes it. */
export const LOD_COLUMNS: Readonly<Record<LodLevel, string>> = {
  0: 'geom',
  1: 'geom_lod1',
  2: 'geom_lod2',
  3: 'geom_lod3',
};

/** Fraction of a pixel of permitted generalization error. */
export const ERROR_BUDGET_PIXELS = 0.5;

export function selectLodForResolution(res: number): LodLevel {
  if (!(res > 0)) throw new Error(`Resolution must be positive, got ${res}`);
  const budget = res * ERROR_BUDGET_PIXELS;
  // Coarsest level whose tolerance still fits inside the budget.
  for (let i = LOD_TOLERANCES.length - 1; i >= 0; i--) {
    if (budget >= LOD_TOLERANCES[i]!) return (i + 1) as LodLevel;
  }
  return 0;
}

export function selectLodForZoom(scheme: TileScheme, z: number): LodLevel {
  return selectLodForResolution(resolution(scheme, z));
}

/**
 * Smallest feature worth drawing at this resolution, in CRS units.
 *
 * Anything whose bounding box is smaller than a few pixels contributes nothing but cost. At
 * millions of objects this cull is one of the largest single wins on the read path.
 */
export function minFeatureSize(res: number, pixels = 4): number {
  return res * pixels;
}

export function bboxDiagonal(bbox: BBox): number {
  return Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]);
}

export function isTooSmallToDraw(bbox: BBox, res: number, pixels = 4): boolean {
  return bboxDiagonal(bbox) < minFeatureSize(res, pixels);
}
