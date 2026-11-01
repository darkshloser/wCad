// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LOD_TOLERANCES, buildLodPyramid, simplify } from '../src/simplify/douglasPeucker.ts';
import type { Coord2 } from '../src/types.ts';

const arbLine = fc.array(
  fc.tuple(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.double({ min: -1e6, max: 1e6, noNaN: true })),
  { minLength: 2, maxLength: 200 },
) as fc.Arbitrary<Coord2[]>;

describe('Douglas-Peucker generalization', () => {
  it('always preserves the endpoints', () => {
    fc.assert(
      fc.property(arbLine, fc.double({ min: 0.001, max: 1000, noNaN: true }), (pts, tol) => {
        const out = simplify(pts, tol);
        expect(out[0]).toEqual([pts[0]![0], pts[0]![1]]);
        expect(out[out.length - 1]).toEqual([pts[pts.length - 1]![0], pts[pts.length - 1]![1]]);
      }),
      { numRuns: 300 },
    );
  });

  it('returns a subsequence of the input', () => {
    fc.assert(
      fc.property(arbLine, fc.double({ min: 0.001, max: 1000, noNaN: true }), (pts, tol) => {
        const out = simplify(pts, tol);
        let i = 0;
        for (const p of out) {
          while (i < pts.length && !(pts[i]![0] === p[0] && pts[i]![1] === p[1])) i++;
          expect(i).toBeLessThan(pts.length);
          i++;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never grows the geometry', () => {
    fc.assert(
      fc.property(arbLine, fc.double({ min: 0.001, max: 1000, noNaN: true }), (pts, tol) => {
        expect(simplify(pts, tol).length).toBeLessThanOrEqual(pts.length);
      }),
      { numRuns: 200 },
    );
  });

  it('is the identity at tolerance 0', () => {
    fc.assert(
      fc.property(arbLine, (pts) => {
        expect(simplify(pts, 0)).toEqual(pts.map((p) => [p[0], p[1]]));
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic — the same input yields the same output', () => {
    fc.assert(
      fc.property(arbLine, fc.double({ min: 0.001, max: 1000, noNaN: true }), (pts, tol) => {
        expect(simplify(pts, tol)).toEqual(simplify(pts, tol));
      }),
      { numRuns: 200 },
    );
  });

  it('is monotone: a coarser tolerance never keeps more points', () => {
    fc.assert(
      fc.property(arbLine, (pts) => {
        const fine = simplify(pts, 1).length;
        const coarse = simplify(pts, 1000).length;
        expect(coarse).toBeLessThanOrEqual(fine);
      }),
      { numRuns: 200 },
    );
  });

  it('collapses a nearly straight line to its endpoints', () => {
    const pts: Coord2[] = [[0, 0], [1, 0.0001], [2, -0.0001], [3, 0.00005], [4, 0]];
    expect(simplify(pts, 1)).toEqual([[0, 0], [4, 0]]);
  });

  it('keeps a genuine corner', () => {
    const pts: Coord2[] = [[0, 0], [5, 50], [10, 0]];
    expect(simplify(pts, 1)).toHaveLength(3);
  });

  it('handles a two-point line and a degenerate repeated point', () => {
    expect(simplify([[0, 0], [1, 1]], 5)).toEqual([[0, 0], [1, 1]]);
    expect(simplify([[3, 3], [3, 3], [3, 3]], 1)).toEqual([[3, 3], [3, 3]]);
  });

  it('does not blow the stack on a very long polyline', () => {
    const pts: Coord2[] = [];
    for (let i = 0; i < 200_000; i++) pts.push([i, Math.sin(i / 1000) * 100]);
    expect(() => simplify(pts, 0.5)).not.toThrow();
  });

  it('builds an LOD pyramid with monotonically decreasing detail', () => {
    const pts: Coord2[] = [];
    for (let i = 0; i < 2000; i++) pts.push([i, Math.sin(i / 50) * 30]);
    const pyramid = buildLodPyramid(pts);
    expect(pyramid).toHaveLength(LOD_TOLERANCES.length);
    for (let i = 1; i < pyramid.length; i++) {
      expect(pyramid[i]!.length).toBeLessThanOrEqual(pyramid[i - 1]!.length);
    }
  });
});
