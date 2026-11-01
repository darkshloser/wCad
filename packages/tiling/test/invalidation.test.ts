// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { dirtyTilesForBBoxes, dirtyTilesForEdit } from '../src/invalidation.ts';
import { createTileScheme, tileBBox, tileContaining } from '../src/scheme.ts';

const EXTENT = [490_000, 4_640_000, 510_000, 4_660_000] as const;
const scheme = createTileScheme('EPSG:32635', EXTENT, { maxZoom: 20 });

const bboxIntersects = (a: readonly number[], b: readonly number[]) =>
  !(a[2]! < b[0]! || a[0]! > b[2]! || a[3]! < b[1]! || a[1]! > b[3]!);

describe('dirty-tile invalidation', () => {
  it('marks one tile per zoom for a point edit', () => {
    const p = [500_000, 4_650_000] as const;
    const { tiles, overflowed } = dirtyTilesForBBoxes(scheme, [[p[0], p[1], p[0], p[1]]], { maxZoom: 10 });
    expect(overflowed).toBe(false);
    expect(tiles).toHaveLength(11); // zooms 0..10 inclusive
    for (let z = 0; z <= 10; z++) {
      const atZ = tiles.filter((t) => t.z === z);
      expect(atZ).toHaveLength(1);
      expect(atZ[0]).toEqual(tileContaining(scheme, z, p));
    }
  });

  it('marks only tiles the geometry actually touches', () => {
    const bbox = [499_000, 4_649_000, 501_000, 4_651_000] as const;
    const { tiles } = dirtyTilesForBBoxes(scheme, [bbox], { maxZoom: 8 });
    for (const tile of tiles) {
      expect(bboxIntersects(tileBBox(scheme, tile), bbox)).toBe(true);
    }
  });

  it('does not evict unaffected tiles', () => {
    const { tiles } = dirtyTilesForBBoxes(scheme, [[499_900, 4_649_900, 500_100, 4_650_100]], { maxZoom: 9 });
    const farAway = tileContaining(scheme, 9, [491_000, 4_641_000])!;
    expect(tiles.some((t) => t.z === farAway.z && t.x === farAway.x && t.y === farAway.y)).toBe(false);
  });

  it('deduplicates tiles shared by several bboxes', () => {
    const box = [500_000, 4_650_000, 500_010, 4_650_010] as const;
    const { tiles } = dirtyTilesForBBoxes(scheme, [box, box, box], { maxZoom: 6 });
    const keys = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
    expect(keys.size).toBe(tiles.length);
  });

  it('covers both the old and the new footprint when an element moves', () => {
    const before = [491_000, 4_641_000, 491_100, 4_641_100] as const;
    const after = [509_000, 4_659_000, 509_100, 4_659_100] as const;
    const { tiles } = dirtyTilesForEdit(scheme, before, after, { maxZoom: 8 });

    // A ghost of the element would remain in cached tiles if the old footprint were skipped.
    const beforeTile = tileContaining(scheme, 8, [491_050, 4_641_050])!;
    const afterTile = tileContaining(scheme, 8, [509_050, 4_659_050])!;
    const has = (t: { z: number; x: number; y: number }) =>
      tiles.some((c) => c.z === t.z && c.x === t.x && c.y === t.y);

    expect(has(beforeTile)).toBe(true);
    expect(has(afterTile)).toBe(true);
  });

  it('handles create (no before) and delete (no after)', () => {
    const box = [500_000, 4_650_000, 500_050, 4_650_050] as const;
    expect(dirtyTilesForEdit(scheme, null, box, { maxZoom: 4 }).tiles.length).toBeGreaterThan(0);
    expect(dirtyTilesForEdit(scheme, box, null, { maxZoom: 4 }).tiles.length).toBeGreaterThan(0);
    expect(dirtyTilesForEdit(scheme, null, null).tiles).toHaveLength(0);
  });

  it('signals overflow instead of emitting millions of rows for a bulk edit', () => {
    const result = dirtyTilesForBBoxes(scheme, [[-1e9, -1e9, 1e9, 1e9]], { maxZoom: 20, maxTiles: 500 });
    expect(result.overflowed).toBe(true);
    expect(result.tiles.length).toBeLessThanOrEqual(501);
  });

  it('respects an explicit zoom window', () => {
    const { tiles } = dirtyTilesForBBoxes(scheme, [[500_000, 4_650_000, 500_010, 4_650_010]], {
      minZoom: 5,
      maxZoom: 7,
    });
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([5, 6, 7]));
  });

  it('never exceeds the scheme maximum zoom', () => {
    const { tiles } = dirtyTilesForBBoxes(scheme, [[500_000, 4_650_000, 500_001, 4_650_001]], { maxZoom: 999 });
    expect(Math.max(...tiles.map((t) => t.z))).toBe(scheme.maxZoom);
  });
});
