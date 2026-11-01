// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MVT_EXTENT, dequantize, quantizationError, quantize } from '../src/quantize.ts';

const TILE = [500_000, 4_650_000, 500_100, 4_650_100] as const;

describe('MVT quantization', () => {
  it('maps tile corners onto the grid corners', () => {
    expect(quantize([TILE[0], TILE[3]], TILE)).toEqual([0, 0]);
    expect(quantize([TILE[2], TILE[1]], TILE)).toEqual([MVT_EXTENT, MVT_EXTENT]);
  });

  it('grows y downward, opposite to the CRS', () => {
    const top = quantize([TILE[0], TILE[3]], TILE);
    const bottom = quantize([TILE[0], TILE[1]], TILE);
    expect(bottom[1]).toBeGreaterThan(top[1]);
  });

  it('emits integers only, as the specification requires', () => {
    fc.assert(
      fc.property(
        fc.double({ min: TILE[0], max: TILE[2], noNaN: true }),
        fc.double({ min: TILE[1], max: TILE[3], noNaN: true }),
        (x, y) => {
          const [qx, qy] = quantize([x, y], TILE);
          expect(Number.isInteger(qx)).toBe(true);
          expect(Number.isInteger(qy)).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  /**
   * The load-bearing test for principle P1. Tiles ARE lossy — this proves it, bounds the loss,
   * and documents why nothing may be edited or snapped from tile geometry.
   */
  it('is lossy, but within the documented bound', () => {
    const tileSize = TILE[2] - TILE[0];
    const bound = quantizationError(tileSize);
    let sawLoss = false;

    fc.assert(
      fc.property(
        fc.double({ min: TILE[0], max: TILE[2], noNaN: true }),
        fc.double({ min: TILE[1], max: TILE[3], noNaN: true }),
        (x, y) => {
          const back = dequantize(quantize([x, y], TILE), TILE);
          const dx = Math.abs(back[0] - x);
          const dy = Math.abs(back[1] - y);
          expect(dx).toBeLessThanOrEqual(bound + 1e-9);
          expect(dy).toBeLessThanOrEqual(bound + 1e-9);
          if (dx > 0 || dy > 0) sawLoss = true;
        },
      ),
      { numRuns: 500 },
    );

    expect(sawLoss).toBe(true);
  });

  it('reports a quantization error of roughly 12 mm on a 100 m tile', () => {
    expect(quantizationError(100)).toBeCloseTo(100 / 4096 / 2, 12);
    expect(quantizationError(100)).toBeGreaterThan(0.01);
  });

  it('scales the error with tile size, so zooming in reduces it', () => {
    expect(quantizationError(1000)).toBeGreaterThan(quantizationError(100));
    expect(quantizationError(1)).toBeLessThan(0.001);
  });

  it('clamps points that fall marginally outside the tile', () => {
    expect(quantize([TILE[0] - 1000, TILE[3] + 1000], TILE)).toEqual([0, 0]);
    expect(quantize([TILE[2] + 1000, TILE[1] - 1000], TILE)).toEqual([MVT_EXTENT, MVT_EXTENT]);
  });
});
