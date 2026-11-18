// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tests for knowledge/snapping-spec.md v2, section by section.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ElementRecord } from '@wcad/store-contract';
import { arcFrom3Points } from '@wcad/geo-core';
import {
  DEFAULT_SNAP_MODES,
  SNAP_DISTANCE_PX,
  SNAP_MODES,
  type SnapGeom,
  type SnapMode,
  cacheCovers,
  findSnap,
  perpendicularAvailable,
  snapActive,
  snapGeomFrom,
  snapStatusLabel,
} from '../src/map/snapping.ts';

// Survey-scale coordinates on purpose: precision problems only show up far from the origin.
const X0 = 500_000;
const Y0 = 4_650_000;

let seq = 0;
function rec(kind: ElementRecord['kind'], coords: number[][], params?: Record<string, number>): ElementRecord {
  seq++;
  return {
    id: `el_${String(seq).padStart(3, '0')}`,
    projectId: 'p',
    layerId: 'default',
    kind,
    crs: 'EPSG:32635',
    coords,
    ...(params ? { params } : {}),
    version: 1,
    bbox: [0, 0, 0, 0],
  };
}

const geoms = (...recs: ElementRecord[]): SnapGeom[] => recs.map((r) => snapGeomFrom(r)!).filter(Boolean);
const only = (...m: SnapMode[]) => new Set<SnapMode>(m);
const ALL = new Set<SnapMode>(SNAP_MODES);
const q = (cursor: [number, number], modes: ReadonlySet<SnapMode>, reference: [number, number] | null = null, tolerance = 1) => ({
  cursor,
  modes,
  reference,
  tolerance,
});

function circleRec(cx: number, cy: number, r: number) {
  return rec('circle', [[cx + r, cy, 0]], { cx, cy, r });
}

function arcRec(p1: [number, number], p2: [number, number], p3: [number, number]) {
  const a = arcFrom3Points(p1, p2, p3);
  return rec('arc', [[p1[0], p1[1], 0], [p3[0], p3[1], 0]], {
    cx: a.center[0],
    cy: a.center[1],
    r: a.radius,
    startAngle: a.startAngle,
    endAngle: a.endAngle,
    ccw: a.ccw ? 1 : 0,
  });
}

describe('§1 modes and defaults', () => {
  it('six modes in priority order; Start/End merged into Endpoint', () => {
    expect(SNAP_MODES).toEqual(['endpoint', 'midpoint', 'centre', 'intersection', 'perpendicular', 'nearest']);
  });
  it('defaults: Endpoint, Midpoint, Centre, Intersection on; Perpendicular, Nearest off', () => {
    expect([...DEFAULT_SNAP_MODES].sort()).toEqual(['centre', 'endpoint', 'intersection', 'midpoint']);
  });
  it('snap distance is 10 px', () => expect(SNAP_DISTANCE_PX).toBe(10));
});

describe('Endpoint', () => {
  it('snaps to every polyline vertex with the stored value, exactly', () => {
    const line = rec('polyline', [[X0 + 0.123456789, Y0 + 0.987654321, 0], [X0 + 50, Y0, 0], [X0 + 100, Y0 + 50, 0]]);
    const t = findSnap(geoms(line), q([X0 + 0.5, Y0 + 0.5], only('endpoint')));
    expect(t).toMatchObject({ mode: 'endpoint', x: X0 + 0.123456789, y: Y0 + 0.987654321, elementId: line.id });
    expect(findSnap(geoms(line), q([X0 + 50.3, Y0 - 0.2], only('endpoint')))?.x).toBe(X0 + 50);
  });

  it('snaps to Point objects and arc ends, not to a circle', () => {
    const pt = rec('point', [[X0, Y0, 0]]);
    expect(findSnap(geoms(pt), q([X0 + 0.4, Y0], only('endpoint')))).toMatchObject({ elementKind: 'point', x: X0 });
    const arc = arcRec([X0, Y0], [X0 + 10, Y0 + 10], [X0 + 20, Y0]);
    expect(findSnap(geoms(arc), q([X0 + 20.2, Y0], only('endpoint')))).toMatchObject({ x: X0 + 20, y: Y0 });
    const circle = circleRec(X0, Y0, 10);
    expect(findSnap(geoms(circle), q([X0 + 10, Y0], only('endpoint')))).toBeNull();
  });

  it('a polygon’s stored closing vertex is not a second target', () => {
    const poly = rec('polygon', [[X0, Y0, 0], [X0 + 10, Y0, 0], [X0 + 10, Y0 + 10, 0], [X0, Y0, 0]]);
    const g = snapGeomFrom(poly)!;
    expect(g.type === 'path' && g.pts.length).toBe(3);
  });
});

describe('Midpoint', () => {
  it('middle of each segment, including a polygon’s closing segment', () => {
    const poly = rec('polygon', [[X0, Y0, 0], [X0 + 10, Y0, 0], [X0 + 10, Y0 + 10, 0], [X0, Y0, 0]]);
    expect(findSnap(geoms(poly), q([X0 + 5.2, Y0 + 0.1], only('midpoint')))).toMatchObject({ x: X0 + 5, y: Y0 });
    // closing segment (X0+10,Y0+10)→(X0,Y0): midpoint (X0+5, Y0+5)
    expect(findSnap(geoms(poly), q([X0 + 5.1, Y0 + 5.1], only('midpoint')))).toMatchObject({ x: X0 + 5, y: Y0 + 5 });
  });

  it('middle of an arc ALONG the arc, not the chord', () => {
    const arc = arcRec([X0 - 10, Y0], [X0, Y0 + 10], [X0 + 10, Y0]); // half circle, centre (X0,Y0), r 10
    const t = findSnap(geoms(arc), q([X0 + 0.3, Y0 + 9.8], only('midpoint')));
    expect(t?.x).toBeCloseTo(X0, 6);
    expect(t?.y).toBeCloseTo(Y0 + 10, 6);
    // The chord midpoint (X0, Y0) is not a target.
    expect(findSnap(geoms(arc), q([X0, Y0 + 0.2], only('midpoint')))).toBeNull();
  });

  it('a circle has no midpoint', () => {
    expect(findSnap(geoms(circleRec(X0, Y0, 10)), q([X0 + 10, Y0], only('midpoint')))).toBeNull();
  });
});

describe('Centre', () => {
  it('circles and arcs, exactly the stored centre', () => {
    const c = circleRec(X0 + 0.111, Y0 + 0.222, 25);
    expect(findSnap(geoms(c), q([X0, Y0], only('centre')))).toMatchObject({ mode: 'centre', x: X0 + 0.111, y: Y0 + 0.222 });
  });
});

describe('Intersection', () => {
  it('two crossing polylines', () => {
    const a = rec('polyline', [[X0 - 10, Y0 - 10, 0], [X0 + 10, Y0 + 10, 0]]);
    const b = rec('polyline', [[X0 - 10, Y0 + 10, 0], [X0 + 10, Y0 - 10, 0]]);
    const t = findSnap(geoms(a, b), q([X0 + 0.4, Y0 - 0.3], only('intersection')));
    expect(t?.mode).toBe('intersection');
    expect(t?.x).toBeCloseTo(X0, 9);
    expect(t?.y).toBeCloseTo(Y0, 9);
  });

  it('a line through a circle', () => {
    const c = circleRec(X0, Y0, 10);
    const l = rec('polyline', [[X0 - 20, Y0, 0], [X0 + 20, Y0, 0]]);
    const t = findSnap(geoms(c, l), q([X0 + 9.7, Y0 + 0.2], only('intersection')));
    expect(t?.x).toBeCloseTo(X0 + 10, 9);
    expect(t?.y).toBeCloseTo(Y0, 9);
  });

  it('two circles', () => {
    const t = findSnap(geoms(circleRec(X0, Y0, 10), circleRec(X0 + 10, Y0, 10)), q([X0 + 5, Y0 + 8.5], only('intersection')));
    expect(t?.x).toBeCloseTo(X0 + 5, 9);
    expect(t?.y).toBeCloseTo(Y0 + Math.sqrt(75), 9);
  });

  it('self-crossing polyline counts; adjacent segments sharing a vertex do not', () => {
    const z = rec('polyline', [[X0, Y0, 0], [X0 + 10, Y0 + 10, 0], [X0 + 10, Y0, 0], [X0, Y0 + 10, 0]]);
    const t = findSnap(geoms(z), q([X0 + 5.2, Y0 + 5.1], only('intersection')));
    expect(t?.x).toBeCloseTo(X0 + 5, 9);
    expect(findSnap(geoms(z), q([X0 + 10, Y0 + 9.6], only('intersection')))).toBeNull();
  });
});

describe('Perpendicular', () => {
  const seg = () => rec('polyline', [[X0, Y0, 0], [X0 + 100, Y0, 0]]);

  it('foot of the perpendicular from the reference point', () => {
    const t = findSnap(geoms(seg()), q([X0 + 30.5, Y0 + 0.3], only('perpendicular'), [X0 + 30, Y0 + 40]));
    expect(t).toMatchObject({ mode: 'perpendicular', x: X0 + 30, y: Y0 });
  });

  it('is exactly 90°: dot product ≈ 0 (property test)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.double({ min: 1, max: 300, noNaN: true }),
        (ax, ay, bx, by, t, off) => {
          const len = Math.hypot(bx - ax, by - ay);
          fc.pre(len > 1);
          const a: [number, number] = [X0 + ax, Y0 + ay];
          const b: [number, number] = [X0 + bx, Y0 + by];
          const foot: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const nx = -(b[1] - a[1]) / len;
          const ny = (b[0] - a[0]) / len;
          const ref: [number, number] = [foot[0] + nx * off, foot[1] + ny * off];
          const r = findSnap(geoms(rec('polyline', [[...a, 0], [...b, 0]])), q(foot, only('perpendicular'), ref, 1e-3));
          if (!r) return false;
          const dot = (r.x - ref[0]) * (b[0] - a[0]) + (r.y - ref[1]) * (b[1] - a[1]);
          return Math.abs(dot) / (len * off) < 1e-6;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('does not extend past the segment', () => {
    expect(findSnap(geoms(seg()), q([X0 + 150, Y0], only('perpendicular'), [X0 + 150, Y0 + 40]))).toBeNull();
  });

  it('on a circle: the point on the line from the centre through the reference', () => {
    const t = findSnap(geoms(circleRec(X0, Y0, 10)), q([X0 + 9.8, Y0 + 0.1], only('perpendicular'), [X0 + 50, Y0]));
    expect(t?.x).toBeCloseTo(X0 + 10, 9);
    expect(t?.y).toBeCloseTo(Y0, 9);
  });

  it('needs a reference point', () => {
    expect(findSnap(geoms(seg()), q([X0 + 30, Y0], only('perpendicular'), null))).toBeNull();
  });

  it('§2 only Polyline and Polygon offer it', () => {
    expect(perpendicularAvailable('line')).toBe(true);
    expect(perpendicularAvailable('polygon')).toBe(true);
    for (const t of ['point', 'circle', 'arc3', 'select', 'pan']) expect(perpendicularAvailable(t)).toBe(false);
  });
});

describe('Nearest', () => {
  it('closest point anywhere on a segment, lying on it (property test)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -200, max: 200, noNaN: true }),
        fc.double({ min: -200, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        (bx, by, t, off) => {
          fc.pre(Math.hypot(bx, by) > 2);
          const a: [number, number] = [X0, Y0];
          const b: [number, number] = [X0 + bx, Y0 + by];
          const cursor: [number, number] = [X0 + bx * t + off, Y0 + by * t - off];
          const r = findSnap(geoms(rec('polyline', [[...a, 0], [...b, 0]])), q(cursor, only('nearest'), null, 1));
          if (!r) return false;
          // Collinear with a→b: cross product relative to the length ≈ 0.
          const cross = (r.x - a[0]) * (b[1] - a[1]) - (r.y - a[1]) * (b[0] - a[0]);
          return Math.abs(cross) / Math.hypot(bx, by) < 1e-6;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('on the true arc, not the tessellation, and clamped to its ends', () => {
    const arc = arcRec([X0 - 10, Y0], [X0, Y0 + 10], [X0 + 10, Y0]);
    const t = findSnap(geoms(arc), q([X0 + 3, Y0 + 9.8], only('nearest')));
    expect(Math.hypot(t!.x - X0, t!.y - Y0)).toBeCloseTo(10, 9);
    // Below the half circle: the nearest point is an end.
    expect(findSnap(geoms(arc), q([X0 + 10.3, Y0 - 0.5], only('nearest')))).toMatchObject({ x: X0 + 10, y: Y0 });
  });
});

describe('§3 priority and determinism', () => {
  it('a higher-priority mode in range beats a nearer lower-priority one', () => {
    const line = rec('polyline', [[X0, Y0, 0], [X0 + 1, Y0, 0]]); // short: endpoint and midpoint both in range
    const t = findSnap(geoms(line), q([X0 + 0.5, Y0], ALL));
    expect(t?.mode).toBe('endpoint');
  });

  it('Nearest only when nothing precise is in range', () => {
    const line = rec('polyline', [[X0, Y0, 0], [X0 + 100, Y0, 0]]);
    expect(findSnap(geoms(line), q([X0 + 30, Y0 + 0.2], ALL))?.mode).toBe('nearest');
    expect(findSnap(geoms(line), q([X0 + 50, Y0 + 0.2], ALL))?.mode).toBe('midpoint');
  });

  it('disabled modes never snap', () => {
    const line = rec('polyline', [[X0, Y0, 0], [X0 + 100, Y0, 0]]);
    expect(findSnap(geoms(line), q([X0, Y0], only('midpoint', 'nearest')))?.mode).toBe('nearest');
    expect(findSnap(geoms(line), q([X0, Y0], only()))).toBeNull();
  });

  it('exact tie between objects is broken by id, independent of input order', () => {
    const a = rec('point', [[X0 - 0.5, Y0, 0]]);
    const b = rec('point', [[X0 + 0.5, Y0, 0]]);
    expect(findSnap(geoms(a, b), q([X0, Y0], ALL))?.elementId).toBe(a.id);
    expect(findSnap(geoms(b, a), q([X0, Y0], ALL))?.elementId).toBe(a.id);
  });

  it('nothing within the tolerance → null', () => {
    expect(findSnap(geoms(rec('point', [[X0, Y0, 0]])), q([X0 + 5, Y0], ALL))).toBeNull();
  });
});

describe('§5, §8 status and on/off', () => {
  it('labels', () => {
    expect(snapStatusLabel(false, null)).toBe('SNAP OFF');
    expect(snapStatusLabel(true, null)).toBe('SNAP');
    for (const mode of SNAP_MODES) {
      expect(snapStatusLabel(true, { x: 0, y: 0, mode, elementId: 'a', elementKind: 'polyline' })).toBe(
        `SNAP · ${mode === 'centre' ? 'centre' : mode}`,
      );
    }
  });
  it('F3 and Alt', () => {
    expect(snapActive({ enabled: true, altHeld: false })).toBe(true);
    expect(snapActive({ enabled: true, altHeld: true })).toBe(false);
    expect(snapActive({ enabled: false, altHeld: false })).toBe(false);
  });
  it('cache window', () => {
    expect(cacheCovers([0, 0, 100, 100], [50, 50], 10)).toBe(true);
    expect(cacheCovers([0, 0, 100, 100], [95, 50], 10)).toBe(false);
    expect(cacheCovers(null, [50, 50], 10)).toBe(false);
  });
});
