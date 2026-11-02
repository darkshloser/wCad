// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type TileScheme,
  childTiles,
  createTileScheme,
  isInPyramid,
  parentTile,
  pyramidExtent,
  resolution,
  tileBBox,
  tileContaining,
  tileCount,
  tileKey,
  tileSize,
  tilesForBBox,
  zoomForResolution,
} from '../src/scheme.ts';

// A realistic Bulgarian UTM 35N project extent: 20 km across.
const EXTENT = [490_000, 4_640_000, 510_000, 4_660_000] as const;
const scheme = createTileScheme('EPSG:32635', EXTENT, { maxZoom: 20 });

describe('tile scheme construction', () => {
  it('produces a square z0 tile that contains the whole extent', () => {
    const bb = tileBBox(scheme, { z: 0, x: 0, y: 0 });
    expect(bb[2] - bb[0]).toBeCloseTo(bb[3] - bb[1], 6);
    expect(bb[0]).toBeLessThanOrEqual(EXTENT[0]);
    expect(bb[1]).toBeLessThanOrEqual(EXTENT[1]);
    expect(bb[2]).toBeGreaterThanOrEqual(EXTENT[2]);
    expect(bb[3]).toBeGreaterThanOrEqual(EXTENT[3]);
  });

  it('tiles in the project CRS, not Web Mercator', () => {
    expect(scheme.crs).toBe('EPSG:32635');
    // z0 covers 20 km plus padding, which only makes sense in metres.
    expect(scheme.z0Size).toBeGreaterThan(20_000);
    expect(scheme.z0Size).toBeLessThan(22_000);
  });

  it('rejects a degenerate extent', () => {
    expect(() => createTileScheme('EPSG:32635', [0, 0, 0, 10])).toThrow(/positive extent/);
    expect(() => createTileScheme('EPSG:32635', [10, 0, 0, 10])).toThrow(/positive extent/);
  });

  it('halves tile size and resolution at each zoom', () => {
    for (let z = 0; z < 10; z++) {
      expect(tileSize(scheme, z + 1)).toBeCloseTo(tileSize(scheme, z) / 2, 9);
      expect(resolution(scheme, z + 1)).toBeCloseTo(resolution(scheme, z) / 2, 12);
    }
  });

  it('rejects out-of-range zooms', () => {
    expect(() => tileSize(scheme, -1)).toThrow(/Zoom must be/);
    expect(() => tileSize(scheme, 21)).toThrow(/Zoom must be/);
    expect(() => tileSize(scheme, 1.5)).toThrow(/Zoom must be/);
  });

  it('inverts resolution back to a usable zoom', () => {
    for (let z = 0; z <= 18; z++) {
      expect(zoomForResolution(scheme, resolution(scheme, z))).toBe(z);
    }
  });

  it('clamps resolution requests beyond the pyramid', () => {
    expect(zoomForResolution(scheme, 1e9)).toBe(0);
    expect(zoomForResolution(scheme, 1e-9)).toBe(scheme.maxZoom);
    expect(() => zoomForResolution(scheme, 0)).toThrow(/positive/);
  });
});

describe('tile geometry', () => {
  it('tiles a zoom level with no gaps and no overlaps', () => {
    const z = 4;
    const n = tileCount(z);
    const size = tileSize(scheme, z);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const bb = tileBBox(scheme, { z, x, y });
        expect(bb[2] - bb[0]).toBeCloseTo(size, 6);
        expect(bb[3] - bb[1]).toBeCloseTo(size, 6);
        if (x > 0) {
          expect(bb[0]).toBeCloseTo(tileBBox(scheme, { z, x: x - 1, y })[2], 6);
        }
        if (y > 0) {
          expect(bb[3]).toBeCloseTo(tileBBox(scheme, { z, x, y: y - 1 })[1], 6);
        }
      }
    }
  });

  // The invariant from IMPLEMENTATION-PLAN.md section 6: every point belongs to exactly one
  // tile. Half-open tile bounds are what make this true on shared boundaries.
  it('assigns every point to exactly one tile', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.double({ min: EXTENT[0], max: EXTENT[2], noNaN: true }),
        fc.double({ min: EXTENT[1], max: EXTENT[3], noNaN: true }),
        (z, x, y) => {
          const tile = tileContaining(scheme, z, [x, y]);
          expect(tile).not.toBeNull();
          const hits = tilesForBBox(scheme, z, [x, y, x, y]);
          expect(hits).toHaveLength(1);
          expect(hits[0]).toEqual(tile);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('places a point inside the bbox of the tile that claims it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.double({ min: EXTENT[0], max: EXTENT[2], noNaN: true }),
        fc.double({ min: EXTENT[1], max: EXTENT[3], noNaN: true }),
        (z, x, y) => {
          const tile = tileContaining(scheme, z, [x, y])!;
          const bb = tileBBox(scheme, tile);
          expect(x).toBeGreaterThanOrEqual(bb[0]);
          expect(x).toBeLessThanOrEqual(bb[2]);
          expect(y).toBeGreaterThanOrEqual(bb[1]);
          expect(y).toBeLessThanOrEqual(bb[3]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('returns null for points outside the pyramid', () => {
    expect(tileContaining(scheme, 3, [0, 0])).toBeNull();
    expect(tileContaining(scheme, 3, [1e9, 1e9])).toBeNull();
  });

  it('covers a bbox completely', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 7 }),
        fc.double({ min: EXTENT[0], max: EXTENT[2] - 1000, noNaN: true }),
        fc.double({ min: EXTENT[1], max: EXTENT[3] - 1000, noNaN: true }),
        fc.double({ min: 10, max: 5000, noNaN: true }),
        (z, x, y, span) => {
          const bbox = [x, y, x + span, y + span] as const;
          const covering = tilesForBBox(scheme, z, bbox);
          expect(covering.length).toBeGreaterThan(0);
          // Every corner of the bbox must fall inside one of the returned tiles.
          for (const corner of [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[0], bbox[3]],
            [bbox[2], bbox[3]],
          ] as Array<[number, number]>) {
            const t = tileContaining(scheme, z, corner);
            if (!t) continue;
            expect(covering.some((c) => c.x === t.x && c.y === t.y)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('returns tiles in deterministic row-major order', () => {
    const a = tilesForBBox(scheme, 5, [495_000, 4_645_000, 505_000, 4_655_000]);
    const b = tilesForBBox(scheme, 5, [495_000, 4_645_000, 505_000, 4_655_000]);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1]!;
      const cur = a[i]!;
      expect(cur.y > prev.y || (cur.y === prev.y && cur.x > prev.x)).toBe(true);
    }
  });

  it('clips a bbox larger than the pyramid instead of returning invalid tiles', () => {
    const tiles = tilesForBBox(scheme, 3, [-1e9, -1e9, 1e9, 1e9]);
    expect(tiles).toHaveLength(tileCount(3) ** 2);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(tileCount(3));
    }
  });

  it('rejects tiles outside the pyramid', () => {
    expect(() => tileBBox(scheme, { z: 2, x: 4, y: 0 })).toThrow(/outside the pyramid/);
    expect(() => tileBBox(scheme, { z: 2, x: -1, y: 0 })).toThrow(/outside the pyramid/);
  });
});

describe('pyramid navigation', () => {
  it('nests children inside their parent', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.nat(), fc.nat(), (z, rx, ry) => {
        const n = tileCount(z);
        const tile = { z, x: rx % n, y: ry % n };
        const parentBox = tileBBox(scheme, tile);
        for (const child of childTiles(tile)) {
          const childBox = tileBBox(scheme, child);
          expect(childBox[0]).toBeGreaterThanOrEqual(parentBox[0] - 1e-6);
          expect(childBox[1]).toBeGreaterThanOrEqual(parentBox[1] - 1e-6);
          expect(childBox[2]).toBeLessThanOrEqual(parentBox[2] + 1e-6);
          expect(childBox[3]).toBeLessThanOrEqual(parentBox[3] + 1e-6);
          expect(parentTile(child)).toEqual(tile);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('has no parent at zoom 0', () => {
    expect(parentTile({ z: 0, x: 0, y: 0 })).toBeNull();
  });

  it('tiles the parent exactly with its four children', () => {
    const tile = { z: 3, x: 2, y: 5 };
    const total = childTiles(tile).reduce((sum, c) => {
      const bb = tileBBox(scheme, c);
      return sum + (bb[2] - bb[0]) * (bb[3] - bb[1]);
    }, 0);
    const pb = tileBBox(scheme, tile);
    expect(total).toBeCloseTo((pb[2] - pb[0]) * (pb[3] - pb[1]), 3);
  });
});

describe('cache keys', () => {
  it('is stable and layer-order independent', () => {
    const t = { z: 5, x: 1, y: 2 };
    expect(tileKey('p1', t)).toBe('p1/5/1/2');
    expect(tileKey('p1', t, ['B', 'A'])).toBe(tileKey('p1', t, ['A', 'B']));
  });

  it('distinguishes projects, tiles and layer sets', () => {
    const t = { z: 5, x: 1, y: 2 };
    const keys = new Set([
      tileKey('p1', t),
      tileKey('p2', t),
      tileKey('p1', { z: 5, x: 1, y: 3 }),
      tileKey('p1', t, ['A']),
      tileKey('p1', t, ['A', 'B']),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe('pyramid bounds (tile errors when zoomed out past the project edge)', () => {
  const scheme = createTileScheme('EPSG:32635', [500000, 4700000, 501000, 4700500]);

  it('pyramidExtent is exactly the zoom-0 tile', () => {
    expect(pyramidExtent(scheme)).toEqual(tileBBox(scheme, { z: 0, x: 0, y: 0 }));
  });

  it('isInPyramid accepts every real tile and rejects the ones the client used to request', () => {
    expect(isInPyramid(scheme, { z: 0, x: 0, y: 0 })).toBe(true);
    expect(isInPyramid(scheme, { z: 3, x: 7, y: 7 })).toBe(true);
    // Straight from the tile service log.
    for (const [x, y] of [[1, 0], [3, 0], [1, 2], [2, 0], [2, 1], [0, 1], [1, 1]] as const) {
      expect(isInPyramid(scheme, { z: 0, x, y }), `0/${x}/${y}`).toBe(false);
    }
    expect(isInPyramid(scheme, { z: 3, x: 8, y: 0 })).toBe(false);
    expect(isInPyramid(scheme, { z: -1, x: 0, y: 0 })).toBe(false);
    expect(isInPyramid(scheme, { z: scheme.maxZoom + 1, x: 0, y: 0 })).toBe(false);
    expect(isInPyramid(scheme, { z: 1, x: 0.5, y: 0 })).toBe(false);
  });
});
