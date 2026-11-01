// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { BBox } from '@wcad/geo-core';
import { type TileCoord, type TileScheme, tilesForBBox } from './scheme.ts';

/**
 * Dirty-tile computation (architecture doc section 5, point 4).
 *
 * An edit invalidates every tile its geometry touches, at every zoom. Tiles are NOT eagerly
 * regenerated — they are evicted and rebuilt lazily on next request, so a burst of edits cannot
 * trigger a regeneration storm.
 *
 * Two bboxes are needed for a move: the element's old footprint and its new one. Forgetting the
 * old one leaves a ghost of the element in cached tiles, which is a confusing bug to chase.
 */

export interface InvalidationOptions {
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Safety limit; beyond it the caller should invalidate whole zoom levels instead. */
  readonly maxTiles?: number;
}

export interface InvalidationResult {
  readonly tiles: readonly TileCoord[];
  /**
   * True when the tile count exceeded `maxTiles` and the caller should fall back to coarse
   * invalidation. Emitting millions of dirty rows for one bulk edit is worse than dropping the
   * affected zoom levels wholesale.
   */
  readonly overflowed: boolean;
}

export function dirtyTilesForBBoxes(
  scheme: TileScheme,
  bboxes: readonly BBox[],
  opts: InvalidationOptions = {},
): InvalidationResult {
  const minZoom = opts.minZoom ?? 0;
  const maxZoom = Math.min(opts.maxZoom ?? scheme.maxZoom, scheme.maxZoom);
  const maxTiles = opts.maxTiles ?? 10_000;

  const seen = new Set<string>();
  const tiles: TileCoord[] = [];

  for (let z = minZoom; z <= maxZoom; z++) {
    for (const bbox of bboxes) {
      for (const tile of tilesForBBox(scheme, z, bbox)) {
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push(tile);
        if (tiles.length > maxTiles) return { tiles, overflowed: true };
      }
    }
  }

  return { tiles, overflowed: false };
}

/** Convenience wrapper for a single element edit, covering both its old and new footprints. */
export function dirtyTilesForEdit(
  scheme: TileScheme,
  before: BBox | null,
  after: BBox | null,
  opts: InvalidationOptions = {},
): InvalidationResult {
  const boxes = [before, after].filter((b): b is BBox => b !== null);
  if (boxes.length === 0) return { tiles: [], overflowed: false };
  return dirtyTilesForBBoxes(scheme, boxes, opts);
}
