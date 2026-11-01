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
import { CrsRegistry, defaultRegistry } from '../src/crs/registry.ts';
import { baseToLocal, baseToLocal3, localToBase, localToBase3, validateLocalCrs } from '../src/crs/localCrs.ts';
import type { CrsDefinition, LocalCrsParams } from '../src/types.ts';

/** Lon/lat boxes where each projected CRS is actually valid, used to generate test points. */
const VALID_LONLAT: Record<string, [number, number, number, number]> = {
  'EPSG:3857': [-179, -80, 179, 80],
  'EPSG:32635': [24.1, 34.5, 29.9, 70],
  'EPSG:7801': [22.4, 41.2, 28.6, 44.2],
  'EPSG:27700': [-7.5, 49.9, 1.7, 58.6],
};

/**
 * Round-trip closure tolerance, in degrees. 1e-9 deg is roughly 0.1 mm.
 *
 * EPSG:27700 is deliberately looser. OSGB36 reaches WGS84 through a 7-parameter Helmert
 * transformation whose inverse proj4 solves iteratively, so closure is millimetre-level rather
 * than exact. This is a property of the datum transformation, not a defect in our code, and it
 * is worth encoding explicitly: changing datum is not a lossless operation, and a CAD tool that
 * pretends otherwise will eventually surprise a surveyor.
 */
const ROUNDTRIP_TOLERANCE_DEG: Record<string, number> = {
  'EPSG:3857': 1e-9,
  'EPSG:32635': 1e-9,
  'EPSG:7801': 1e-9,
  'EPSG:27700': 5e-8,
};

describe('CrsRegistry', () => {
  it('registers all built-in systems', () => {
    for (const code of Object.keys(VALID_LONLAT)) {
      expect(defaultRegistry.has(code)).toBe(true);
    }
    expect(defaultRegistry.has('EPSG:4326')).toBe(true);
  });

  it('throws a clear error for an unknown CRS', () => {
    expect(() => defaultRegistry.get('EPSG:99999')).toThrow(/Unknown CRS/);
  });

  it('exposes axis labels so the UI never hardcodes X/Y', () => {
    expect(defaultRegistry.axisLabels('EPSG:4326')).toEqual(['Lon', 'Lat', 'H']);
    expect(defaultRegistry.axisLabels('EPSG:7801')).toEqual(['N', 'E', 'H']);
    expect(defaultRegistry.axisLabels('EPSG:3857')).toEqual(['X', 'Y', 'Z']);
  });

  it('is an identity transform when source and target match', () => {
    const p = [500123.456789, 4650321.10456] as const;
    expect(defaultRegistry.transform('EPSG:32635', 'EPSG:32635', p)).toEqual([p[0], p[1]]);
  });

  it('rejects a projected CRS registered without a proj4 string', () => {
    const r = new CrsRegistry([]);
    expect(() =>
      r.register({
        code: 'BAD',
        name: 'bad',
        kind: 'projected',
        axisLabels: ['X', 'Y', 'Z'],
        units: 'm',
        extent: [0, 0, 1, 1],
      } as CrsDefinition),
    ).toThrow(/requires a proj4 string/);
  });

  // The single most important test in geo-core: if these transforms are wrong, every
  // coordinate in the system is wrong in a way that looks entirely plausible.
  describe.each(Object.keys(VALID_LONLAT))('round-trip through %s', (code) => {
    it('WGS84 -> projected -> WGS84 closes within the documented tolerance', () => {
      const [minLon, minLat, maxLon, maxLat] = VALID_LONLAT[code]!;
      const tol = ROUNDTRIP_TOLERANCE_DEG[code]!;
      fc.assert(
        fc.property(
          fc.double({ min: minLon, max: maxLon, noNaN: true }),
          fc.double({ min: minLat, max: maxLat, noNaN: true }),
          (lon, lat) => {
            const projected = defaultRegistry.transform('EPSG:4326', code, [lon, lat]);
            expect(Number.isFinite(projected[0])).toBe(true);
            expect(Number.isFinite(projected[1])).toBe(true);
            const back = defaultRegistry.transform(code, 'EPSG:4326', projected);
            expect(Math.abs(back[0] - lon)).toBeLessThan(tol);
            expect(Math.abs(back[1] - lat)).toBeLessThan(tol);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  /**
   * Anchor tests. Bounds are derived from the projection parameters by hand rather than copied
   * from this library's own output — otherwise the test would simply agree with whatever the
   * code does, including a wrong proj4 string.
   */
  it('places Varna correctly in UTM zone 35N', () => {
    // Zone 35 central meridian is 27E with a 500000 false easting. Varna sits 0.91 east of it,
    // so easting = 500000 + 0.91 * 111320 * cos(43.2) * 0.9996 ~= 574000.
    // Northing is the meridian arc to 43.21N, ~4785 km.
    const [e, n] = defaultRegistry.transform('EPSG:4326', 'EPSG:32635', [27.9147, 43.2141]);
    expect(e).toBeGreaterThan(571000);
    expect(e).toBeLessThan(577000);
    expect(n).toBeGreaterThan(4780000);
    expect(n).toBeLessThan(4790000);
  });

  it('places Sofia correctly in BGS2005 / CCS2005', () => {
    // CCS2005 has lon_0 = 25.5 with x_0 = 500000, and lat_0 = 42.6679 with y_0 = 4725824.36.
    // Sofia is 2.18 west of the central meridian: 500000 - 2.18 * 111320 * cos(42.7) ~= 321500.
    // It is 0.03 north of lat_0, so northing ~= 4725824 + 3300 ~= 4729000.
    const [e, n] = defaultRegistry.transform('EPSG:4326', 'EPSG:7801', [23.3219, 42.6977]);
    expect(e).toBeGreaterThan(318000);
    expect(e).toBeLessThan(325000);
    expect(n).toBeGreaterThan(4727000);
    expect(n).toBeLessThan(4735000);
  });

  it('rejects a coordinate transform between systems that are far apart as implausible', () => {
    // Sofia expressed in the British National Grid falls far outside the grid extent; the
    // transform still succeeds numerically, which is exactly why extent validation matters.
    const [e] = defaultRegistry.transform('EPSG:4326', 'EPSG:27700', [23.3219, 42.6977]);
    const extent = defaultRegistry.get('EPSG:27700').extent;
    expect(e < extent[0] || e > extent[2]).toBe(true);
  });
});

describe('local / site coordinate systems', () => {
  const arbParams = fc.record({
    baseCrs: fc.constant('EPSG:32635'),
    origin: fc.tuple(
      fc.double({ min: 100000, max: 900000, noNaN: true }),
      fc.double({ min: 4000000, max: 5000000, noNaN: true }),
    ),
    rotation: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
    scale: fc.double({ min: 0.5, max: 2, noNaN: true }),
    heightOffset: fc.double({ min: -1000, max: 1000, noNaN: true }),
  }) as fc.Arbitrary<LocalCrsParams>;

  it('local -> base -> local is the identity within 1e-6 m', () => {
    fc.assert(
      fc.property(
        arbParams,
        fc.double({ min: -10000, max: 10000, noNaN: true }),
        fc.double({ min: -10000, max: 10000, noNaN: true }),
        (params, x, y) => {
          const back = baseToLocal(localToBase([x, y], params), params);
          expect(Math.abs(back[0] - x)).toBeLessThan(1e-6);
          expect(Math.abs(back[1] - y)).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('carries height as an offset in both directions', () => {
    fc.assert(
      fc.property(arbParams, fc.double({ min: -500, max: 500, noNaN: true }), (params, h) => {
        const back = baseToLocal3(localToBase3([10, 20, h], params), params);
        expect(Math.abs(back[2] - h)).toBeLessThan(1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it('preserves distances up to the scale factor', () => {
    const params: LocalCrsParams = {
      baseCrs: 'EPSG:32635',
      origin: [500000, 4650000],
      rotation: 0.7,
      scale: 1.000_25,
      heightOffset: 0,
    };
    const a = localToBase([0, 0], params);
    const b = localToBase([100, 0], params);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(100 * params.scale, 9);
  });

  it('rejects a non-invertible scale', () => {
    expect(() =>
      validateLocalCrs({ baseCrs: 'EPSG:32635', origin: [0, 0], rotation: 0, scale: 0, heightOffset: 0 }),
    ).toThrow(/non-zero/);
  });

  it('transforms through the registry between a local system and WGS84', () => {
    const registry = new CrsRegistry();
    registry.register({
      code: 'local:site-A',
      name: 'Site A',
      kind: 'local',
      axisLabels: ['N', 'E', 'H'],
      units: 'm',
      extent: [-5000, -5000, 5000, 5000],
      local: {
        baseCrs: 'EPSG:32635',
        origin: [300000, 4730000],
        rotation: 0.15,
        scale: 1,
        heightOffset: 550,
      },
    });
    const wgs = registry.transform('local:site-A', 'EPSG:4326', [100, 200]);
    expect(wgs[0]).toBeGreaterThan(22);
    expect(wgs[0]).toBeLessThan(25);
    const back = registry.transform('EPSG:4326', 'local:site-A', wgs);
    expect(Math.abs(back[0] - 100)).toBeLessThan(1e-6);
    expect(Math.abs(back[1] - 200)).toBeLessThan(1e-6);
  });

  it('refuses a local CRS anchored to an unknown base', () => {
    const registry = new CrsRegistry();
    expect(() =>
      registry.register({
        code: 'local:bad',
        name: 'bad',
        kind: 'local',
        axisLabels: ['N', 'E', 'H'],
        units: 'm',
        extent: [0, 0, 1, 1],
        local: { baseCrs: 'EPSG:00000', origin: [0, 0], rotation: 0, scale: 1, heightOffset: 0 },
      }),
    ).toThrow(/unknown base CRS/);
  });
});
