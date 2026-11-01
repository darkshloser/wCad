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
  assertRenderPrecision,
  chooseRenderOrigin,
  float32Resolution,
  rebaseToFloat32,
  unrebaseFromFloat32,
  worstCaseResolution,
} from '../src/precision/rebase.ts';
import { defaultRegistry } from '../src/crs/registry.ts';

describe('float32 precision and render-origin rebasing', () => {
  it('computes float32 resolution correctly at known magnitudes', () => {
    expect(float32Resolution(1)).toBeCloseTo(2 ** -23, 30);
    expect(float32Resolution(4_650_321)).toBeCloseTo(2 ** (22 - 23), 10); // ~0.5 m
    expect(float32Resolution(0)).toBeGreaterThan(0);
  });

  // This is the test that proves the architecture doc section 5.2 problem is real.
  it('demonstrates that raw projected coordinates lose sub-metre detail in float32', () => {
    const northing = 4_650_321.104;
    const asF32 = Math.fround(northing);
    expect(Math.abs(asF32 - northing)).toBeGreaterThan(0.01);
    expect(float32Resolution(northing)).toBeGreaterThan(0.1);
  });

  it('recovers millimetre resolution once rebased to a render origin', () => {
    const extent = [499_000, 4_649_000, 501_000, 4_651_000] as const;
    const origin = chooseRenderOrigin(extent);
    expect(worstCaseResolution(extent, origin)).toBeLessThan(0.001);
    expect(() => assertRenderPrecision(extent, origin, 0.001)).not.toThrow();
  });

  it('fails loudly when an origin cannot deliver the required resolution', () => {
    const extent = [0, 0, 20_000_000, 20_000_000] as const;
    expect(() => assertRenderPrecision(extent, [0, 0], 0.001)).toThrow(/coarser than the required/);
  });

  it('every built-in projected CRS reaches 1 mm when rebased over a 10 km working extent', () => {
    for (const def of defaultRegistry.list()) {
      if (def.units !== 'm') continue;
      const cx = (def.extent[0] + def.extent[2]) / 2;
      const cy = (def.extent[1] + def.extent[3]) / 2;
      const working = [cx - 5000, cy - 5000, cx + 5000, cy + 5000] as const;
      const origin = chooseRenderOrigin(working);
      expect(worstCaseResolution(working, origin)).toBeLessThan(0.001);
    }
  });

  it('round-trips rebased coordinates within the float32 resolution bound', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.double({ min: 499_000, max: 501_000, noNaN: true }),
            fc.double({ min: 4_649_000, max: 4_651_000, noNaN: true }),
          ),
          { minLength: 1, maxLength: 64 },
        ),
        (coords) => {
          const origin = chooseRenderOrigin([499_000, 4_649_000, 501_000, 4_651_000]);
          const buf = rebaseToFloat32(coords as Array<readonly [number, number]>, origin);
          const back = unrebaseFromFloat32(buf, origin);
          for (let i = 0; i < coords.length; i++) {
            expect(Math.abs(back[i]![0] - coords[i]![0])).toBeLessThan(0.001);
            expect(Math.abs(back[i]![1] - coords[i]![1])).toBeLessThan(0.001);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('produces a packed buffer of the expected length', () => {
    const buf = rebaseToFloat32([[1, 2], [3, 4], [5, 6]], [0, 0]);
    expect(buf).toBeInstanceOf(Float32Array);
    expect(buf.length).toBe(6);
  });
});
