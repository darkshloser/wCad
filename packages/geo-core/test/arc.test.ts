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
import {
  type Arc,
  TAU,
  angleWithinArc,
  arcBBox,
  arcFrom3Points,
  arcLength,
  endPoint,
  midPoint,
  pointAt,
  startPoint,
  sweepAngle,
  validateArc,
} from '../src/arc/arc.ts';
import { arcToBulge, bulgeToArc } from '../src/arc/bulge.ts';
import { MAX_SEGMENTS, sagittaError, segmentCount, tessellate } from '../src/arc/tessellate.ts';
import {
  arcArcIntersections,
  circleCircleIntersections,
  lineCircleIntersections,
  segmentArcIntersections,
  segmentSegmentIntersection,
} from '../src/arc/intersect.ts';

const quarter: Arc = { center: [0, 0], radius: 10, startAngle: 0, endAngle: Math.PI / 2, ccw: true };

const arbArc = fc.record({
  center: fc.tuple(fc.double({ min: -1000, max: 1000, noNaN: true }), fc.double({ min: -1000, max: 1000, noNaN: true })),
  radius: fc.double({ min: 0.01, max: 1000, noNaN: true }),
  startAngle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  endAngle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  ccw: fc.boolean(),
}) as fc.Arbitrary<Arc>;

describe('arc geometry', () => {
  it('computes a quarter-circle sweep and length', () => {
    expect(sweepAngle(quarter)).toBeCloseTo(Math.PI / 2, 12);
    expect(arcLength(quarter)).toBeCloseTo((Math.PI / 2) * 10, 12);
  });

  it('treats start === end as a full circle in the sweep direction', () => {
    expect(sweepAngle({ ...quarter, endAngle: 0 })).toBeCloseTo(TAU, 12);
    expect(sweepAngle({ ...quarter, endAngle: 0, ccw: false })).toBeCloseTo(-TAU, 12);
  });

  it('places endpoints exactly on the circle', () => {
    const s = startPoint(quarter);
    const e = endPoint(quarter);
    expect(s[0]).toBeCloseTo(10, 12);
    expect(s[1]).toBeCloseTo(0, 12);
    expect(e[0]).toBeCloseTo(0, 12);
    expect(e[1]).toBeCloseTo(10, 12);
  });

  it('pointAt(0) and pointAt(1) equal the endpoints bit-exactly', () => {
    fc.assert(
      fc.property(arbArc, (arc) => {
        expect(pointAt(arc, 0)).toEqual(startPoint(arc));
        expect(pointAt(arc, 1)).toEqual(endPoint(arc));
      }),
      { numRuns: 300 },
    );
  });

  it('keeps every parametric point on the circle', () => {
    fc.assert(
      fc.property(arbArc, fc.double({ min: 0, max: 1, noNaN: true }), (arc, t) => {
        const p = pointAt(arc, t);
        const d = Math.hypot(p[0] - arc.center[0], p[1] - arc.center[1]);
        expect(Math.abs(d - arc.radius)).toBeLessThan(1e-9 * Math.max(1, arc.radius));
      }),
      { numRuns: 500 },
    );
  });

  it('reports the midpoint on the arc', () => {
    const m = midPoint(quarter);
    expect(Math.hypot(m[0], m[1])).toBeCloseTo(10, 12);
    expect(angleWithinArc(quarter, Math.atan2(m[1], m[0]))).toBe(true);
  });

  it('bounds a quarter arc tightly rather than using the whole circle', () => {
    // Not toEqual: cos(pi/2) is 6.1e-17 rather than exactly 0, so the box is correct to
    // within floating-point noise but not bit-identical. Asserting exact equality here would
    // be testing the IEEE-754 representation of pi/2, not the bounding logic.
    const bb = arcBBox(quarter);
    expect(bb[0]).toBeCloseTo(0, 12);
    expect(bb[1]).toBeCloseTo(0, 12);
    expect(bb[2]).toBeCloseTo(10, 12);
    expect(bb[3]).toBeCloseTo(10, 12);
  });

  it('includes cardinal extremes the arc actually crosses', () => {
    const spanning: Arc = { center: [0, 0], radius: 5, startAngle: -0.2, endAngle: 0.2, ccw: true };
    const bb = arcBBox(spanning);
    expect(bb[2]).toBeCloseTo(5, 12); // crosses angle 0, so max x is the full radius
  });

  it('rejects degenerate arcs', () => {
    expect(() => validateArc({ ...quarter, radius: 0 })).toThrow(/positive finite/);
    expect(() => validateArc({ ...quarter, radius: -1 })).toThrow(/positive finite/);
    expect(() => validateArc({ ...quarter, startAngle: NaN })).toThrow(/finite/);
  });

  it('constructs an arc through three points', () => {
    const a = arcFrom3Points([10, 0], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], [0, 10]);
    expect(a.radius).toBeCloseTo(10, 9);
    expect(a.center[0]).toBeCloseTo(0, 9);
    expect(a.center[1]).toBeCloseTo(0, 9);
    expect(a.ccw).toBe(true);
  });

  it('detects the clockwise case in three-point construction', () => {
    const a = arcFrom3Points([0, 10], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], [10, 0]);
    expect(a.ccw).toBe(false);
    expect(a.radius).toBeCloseTo(10, 9);
  });

  it('rejects collinear three-point input', () => {
    expect(() => arcFrom3Points([0, 0], [1, 1], [2, 2])).toThrow(/collinear/);
  });
});

describe('DXF bulge conversion', () => {
  it('treats bulge 1 as a semicircle', () => {
    const arc = bulgeToArc([0, 0], [10, 0], 1);
    expect(arc.radius).toBeCloseTo(5, 12);
    expect(arc.center[0]).toBeCloseTo(5, 12);
    expect(arc.center[1]).toBeCloseTo(0, 12);
    expect(arc.ccw).toBe(true);
  });

  it('round-trips bulge -> arc -> bulge', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -0.999, max: 0.999, noNaN: true }).filter((b) => Math.abs(b) > 1e-6),
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: 1, max: 500, noNaN: true }),
        (bulge, x1, y1, dx) => {
          const p1 = [x1, y1] as const;
          const p2 = [x1 + dx, y1] as const;
          const arc = bulgeToArc(p1, p2, bulge);
          const seg = arcToBulge(arc);
          expect(Math.abs(seg.bulge - bulge)).toBeLessThan(1e-9);
          expect(Math.abs(seg.p1[0] - p1[0])).toBeLessThan(1e-6);
          expect(Math.abs(seg.p2[0] - p2[0])).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('encodes sweep direction in the bulge sign', () => {
    expect(bulgeToArc([0, 0], [10, 0], 0.5).ccw).toBe(true);
    expect(bulgeToArc([0, 0], [10, 0], -0.5).ccw).toBe(false);
    expect(arcToBulge(bulgeToArc([0, 0], [10, 0], -0.5)).bulge).toBeLessThan(0);
  });

  it('rejects a zero bulge and coincident endpoints', () => {
    expect(() => bulgeToArc([0, 0], [1, 0], 0)).toThrow(/straight segment/);
    expect(() => bulgeToArc([0, 0], [0, 0], 0.5)).toThrow(/coincident/);
  });
});

describe('arc tessellation', () => {
  it('keeps sagitta error within tolerance', () => {
    fc.assert(
      fc.property(arbArc, fc.double({ min: 0.001, max: 1, noNaN: true }), (arc, tol) => {
        const n = segmentCount(arc, tol);
        expect(sagittaError(arc, n)).toBeLessThanOrEqual(tol + 1e-9);
      }),
      { numRuns: 400 },
    );
  });

  it('preserves the exact endpoints', () => {
    fc.assert(
      fc.property(arbArc, (arc) => {
        const pts = tessellate(arc, 0.01);
        expect(pts[0]).toEqual(startPoint(arc));
        expect(pts[pts.length - 1]).toEqual(endPoint(arc));
      }),
      { numRuns: 300 },
    );
  });

  it('produces segmentCount + 1 points', () => {
    fc.assert(
      fc.property(arbArc, (arc) => {
        expect(tessellate(arc, 0.05).length).toBe(segmentCount(arc, 0.05) + 1);
      }),
      { numRuns: 200 },
    );
  });

  it('uses more segments for a tighter tolerance', () => {
    const coarse = segmentCount(quarter, 1);
    const fine = segmentCount(quarter, 0.001);
    expect(fine).toBeGreaterThan(coarse);
  });

  it('uses more segments for a larger radius at fixed tolerance', () => {
    const small = segmentCount({ ...quarter, radius: 1 }, 0.01);
    const large = segmentCount({ ...quarter, radius: 1000 }, 0.01);
    expect(large).toBeGreaterThan(small);
  });

  it('caps segment count so a pathological request cannot hang the renderer', () => {
    const n = segmentCount({ center: [0, 0], radius: 1e9, startAngle: 0, endAngle: 0, ccw: true }, 1e-9);
    expect(n).toBeLessThanOrEqual(MAX_SEGMENTS);
  });

  it('rejects a non-positive tolerance', () => {
    expect(() => segmentCount(quarter, 0)).toThrow(/tolerance/);
  });
});

describe('intersections', () => {
  it('finds both line-circle crossings', () => {
    const pts = lineCircleIntersections([-20, 0], [20, 0], [0, 0], 10);
    expect(pts).toHaveLength(2);
    expect(pts.map((p) => p[0]).sort((a, b) => a - b)).toEqual([-10, 10]);
  });

  it('returns a single point for a tangent line', () => {
    expect(lineCircleIntersections([-20, 10], [20, 10], [0, 0], 10)).toHaveLength(1);
  });

  it('returns nothing for a missing line', () => {
    expect(lineCircleIntersections([-20, 50], [20, 50], [0, 0], 10)).toHaveLength(0);
  });

  it('finds circle-circle crossings and handles the separated case', () => {
    expect(circleCircleIntersections([0, 0], 10, [15, 0], 10)).toHaveLength(2);
    expect(circleCircleIntersections([0, 0], 1, [100, 0], 1)).toHaveLength(0);
    expect(circleCircleIntersections([0, 0], 5, [0, 0], 5)).toHaveLength(0); // concentric
    expect(circleCircleIntersections([0, 0], 10, [20, 0], 10)).toHaveLength(1); // tangent
  });

  it('restricts segment-arc intersections to the swept range', () => {
    const full = segmentArcIntersections([-20, 0], [20, 0], {
      center: [0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: 0,
      ccw: true,
    });
    expect(full).toHaveLength(2);

    const upperHalf: Arc = { center: [0, 0], radius: 10, startAngle: 0, endAngle: Math.PI, ccw: true };
    const clipped = segmentArcIntersections([-20, 0], [20, 0], upperHalf);
    expect(clipped).toHaveLength(2); // both endpoints of the half-circle lie on y = 0
    const quarterOnly = segmentArcIntersections([-20, 0], [20, 0], quarter);
    expect(quarterOnly).toHaveLength(1);
    expect(quarterOnly[0]![0]).toBeCloseTo(10, 9);
  });

  it('restricts arc-arc intersections to both swept ranges', () => {
    const a: Arc = { center: [0, 0], radius: 10, startAngle: 0, endAngle: Math.PI, ccw: true };
    const b: Arc = { center: [15, 0], radius: 10, startAngle: 0, endAngle: Math.PI, ccw: true };
    const hits = arcArcIntersections(a, b);
    expect(hits).toHaveLength(1);
    expect(hits[0]![1]).toBeGreaterThan(0);
  });

  it('intersects and rejects segments correctly', () => {
    expect(segmentSegmentIntersection([0, 0], [10, 10], [0, 10], [10, 0])).toEqual([5, 5]);
    expect(segmentSegmentIntersection([0, 0], [1, 1], [5, 5], [6, 6])).toBeNull(); // collinear apart
    expect(segmentSegmentIntersection([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull(); // parallel
    expect(segmentSegmentIntersection([0, 0], [1, 1], [10, 0], [10, 5])).toBeNull(); // beyond range
  });
});
