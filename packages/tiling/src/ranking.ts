// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { BBox } from '@wcad/geo-core';

/**
 * Per-tile element caps with deterministic importance ordering.
 *
 * A cap is what bounds the worst case: without one, a single dense tile in a city centre can
 * contain a million elements and blow every budget in the system. With one, tile cost is bounded
 * regardless of how pathological the data is.
 *
 * The ordering MUST be deterministic. Tiles are cached and compared byte-for-byte, so a ranking
 * that depends on database row order or floating-point tie-breaking produces tiles that differ
 * between generations and silently defeats the cache.
 */

export interface RankableElement {
  readonly id: string;
  readonly bbox: BBox;
  /** Lower sorts first. Comes from layer configuration, not from the data. */
  readonly layerPriority: number;
}

export function bboxArea(bbox: BBox): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

/**
 * Deterministic total order: layer priority, then visual weight (larger first), then id.
 *
 * The final id comparison is what makes it a *total* order — without it, two identically sized
 * elements on the same layer could come back in either order.
 */
export function compareForTile(a: RankableElement, b: RankableElement): number {
  if (a.layerPriority !== b.layerPriority) return a.layerPriority - b.layerPriority;
  const areaA = bboxArea(a.bbox);
  const areaB = bboxArea(b.bbox);
  if (areaA !== areaB) return areaB - areaA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankForTile<T extends RankableElement>(elements: readonly T[], limit: number): T[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Element cap must be a non-negative integer, got ${limit}`);
  }
  return [...elements].sort(compareForTile).slice(0, limit);
}

/** Default cap per tile per layer. Tuned so a worst-case tile stays inside the 300 ms budget. */
export const DEFAULT_TILE_ELEMENT_CAP = 20_000;
