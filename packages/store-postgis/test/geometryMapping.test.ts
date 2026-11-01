// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LOD_TOLERANCES, simplify } from '@wcad/geo-core';
import {
  bboxDiagonal,
  buildLodGeometries,
  closeRing,
  computeBBox,
  toWkbGeometry,
  wkbTypeForKind,
} from '../src/geometryMapping.ts';
import { decodeEwkb, encodeEwkb } from '../src/wkb.ts';

describe('kind to geometry mapping', () => {
  it('maps CAD kinds onto the right PostGIS types', () => {
    expect(wkbTypeForKind('point', 1)).toBe('Point');
    expect(wkbTypeForKind('text', 1)).toBe('Point');
    expect(wkbTypeForKind('insert', 1)).toBe('Point');
    expect(wkbTypeForKind('polygon', 4)).toBe('Polygon');
    expect(wkbTypeForKind('polyline', 5)).toBe('LineString');
    expect(wkbTypeForKind('arc', 20)).toBe('LineString');
    expect(wkbTypeForKind('circle', 30)).toBe('LineString');
  });

  it('degrades a single-vertex polyline to a point rather than failing', () => {
    expect(wkbTypeForKind('polyline', 1)).toBe('Point');
  });

  it('rejects an element with no coordinates', () => {
    expect(() => toWkbGeometry('polyline', [], 32635)).toThrow(/no coordinates/);
  });

  it('detects 3D only when every vertex carries Z', () => {
    expect(toWkbGeometry('polyline', [[0, 0, 1], [1, 1, 2]], 1).hasZ).toBe(true);
    expect(toWkbGeometry('polyline', [[0, 0, 1], [1, 1]], 1).hasZ).toBe(false);
  });
});

describe('polygon ring closing', () => {
  it('closes an open ring', () => {
    const ring = closeRing([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(ring).toHaveLength(5);
    expect(ring[4]).toEqual(ring[0]);
  });

  it('leaves an already closed ring alone', () => {
    const input = [[0, 0], [10, 0], [10, 10], [0, 0]];
    expect(closeRing(input)).toHaveLength(4);
  });

  it('pads a degenerate ring up to the four coordinates PostGIS requires', () => {
    expect(closeRing([[5, 5], [6, 6]]).length).toBeGreaterThanOrEqual(4);
  });

  it('produces rings that encode without error', () => {
    const g = toWkbGeometry('polygon', [[0, 0], [10, 0], [10, 10], [0, 10]], 32635);
    expect(() => encodeEwkb(g)).not.toThrow();
    expect(decodeEwkb(encodeEwkb(g)).type).toBe('Polygon');
  });
});

describe('bounding boxes', () => {
  it('bounds a polyline', () => {
    expect(computeBBox([[0, 0], [10, -5], [3, 8]])).toEqual([0, -5, 10, 8]);
  });

  it('expands to the full circle envelope for parametric elements', () => {
    expect(computeBBox([[10, 0]], { cx: 0, cy: 0, r: 10 })).toEqual([-10, -10, 10, 10]);
  });

  it('computes the diagonal used for ranking and culling', () => {
    expect(bboxDiagonal([0, 0, 3, 4])).toBe(5);
  });

  it('throws rather than storing a nonsense box', () => {
    expect(() => computeBBox([])).toThrow(/without coordinates/);
  });
});

describe('LOD generation', () => {
  const wavy = Array.from({ length: 500 }, (_, i) => [i * 2, Math.sin(i / 10) * 30] as const);

  it('never drops a point element at any level', () => {
    const lods = buildLodGeometries('point', [[5, 5]], 32635);
    expect(lods.lod1).not.toBeNull();
    expect(lods.lod3).not.toBeNull();
  });

  it('reduces vertex count monotonically as tolerance grows', () => {
    const lods = buildLodGeometries('polyline', wavy, 32635);
    const n1 = lods.lod1!.coordinates.length;
    const n2 = lods.lod2!.coordinates.length;
    expect(n1).toBeLessThanOrEqual(wavy.length);
    expect(n2).toBeLessThanOrEqual(n1);
    if (lods.lod3) expect(lods.lod3.coordinates.length).toBeLessThanOrEqual(n2);
  });

  // Client and server must generalize identically or the backdrop disagrees with the working set.
  it('uses exactly the shared geo-core generalization', () => {
    const lods = buildLodGeometries('polyline', wavy, 32635);
    const expected = simplify(wavy.map((c) => [c[0], c[1]] as [number, number]), LOD_TOLERANCES[0]!);
    expect(lods.lod1!.coordinates.map((c) => [c[0], c[1]])).toEqual(expected.map((c) => [c[0], c[1]]));
  });

  it('returns null when a level collapses below the minimum vertex count', () => {
    // A 1 m square vanishes at 100 m tolerance.
    const tiny = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    expect(buildLodGeometries('polygon', tiny, 32635).lod3).toBeNull();
  });

  it('keeps every level encodable', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.double({ min: -1e5, max: 1e5, noNaN: true }), fc.double({ min: -1e5, max: 1e5, noNaN: true })),
          { minLength: 2, maxLength: 80 },
        ),
        (coords) => {
          const lods = buildLodGeometries('polyline', coords, 32635);
          for (const g of [lods.lod1, lods.lod2, lods.lod3]) {
            if (g) expect(() => encodeEwkb(g)).not.toThrow();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
