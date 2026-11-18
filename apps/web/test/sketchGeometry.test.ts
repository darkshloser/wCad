// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

// knowledge/drawing-style-spec.md

import { describe, expect, it } from 'vitest';
import { OTHER_STATE_COLOURS, sketchColours, splitOpenSketch, splitPolygonSketch } from '../src/map/sketchGeometry.ts';

const A = [0, 0];
const B = [10, 0];
const C = [10, 10];
const CUR = [3, 7];

describe('§2 colour', () => {
  it('white-grey on dark, dark grey on light', () => {
    expect(sketchColours('dark').stroke).toBe('#e5e7eb');
    expect(sketchColours('light').stroke).toBe('#374151');
  });

  it('never a colour of another state', () => {
    for (const bg of ['dark', 'light'] as const) {
      expect(OTHER_STATE_COLOURS).not.toContain(sketchColours(bg).stroke);
    }
  });
});

describe('§3 polyline sketch', () => {
  it('first click: one placed vertex, rubber band to the cursor', () => {
    expect(splitOpenSketch([A, CUR])).toEqual({ placed: [A], rubber: [A, CUR] });
  });

  it('later: placed part is everything but the cursor; rubber band from the last vertex', () => {
    expect(splitOpenSketch([A, B, C, CUR])).toEqual({ placed: [A, B, C], rubber: [C, CUR] });
  });

  it('no rubber band without a cursor', () => {
    expect(splitOpenSketch([A]).rubber).toBeNull();
  });
});

describe('§3 polygon sketch', () => {
  it('ring = placed…, cursor, first → placed, rubber band and closing edge', () => {
    expect(splitPolygonSketch([A, B, C, CUR, A])).toEqual({
      placed: [A, B, C],
      rubber: [C, CUR],
      closing: [CUR, A],
    });
  });

  it('no closing edge until two vertices are placed (it would duplicate the rubber band)', () => {
    expect(splitPolygonSketch([A, CUR, A])).toEqual({ placed: [A], rubber: [A, CUR], closing: null });
  });
});
