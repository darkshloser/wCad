// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  EWKB_FLAG_SRID,
  EWKB_FLAG_Z,
  type WkbGeometry,
  decodeEwkb,
  encodeEwkb,
  fromHex,
  toHex,
} from '../src/wkb.ts';

const PRECISION_COORDS = [
  [500123.45678901234, 4650321.104567891, 12.345678901234567],
  [500123.4567890124, 4650321.104567892, 12.345678901234569],
  [0.1 + 0.2, 1e-15, -0.30000000000000004],
  [Number.MAX_SAFE_INTEGER / 1e3, -4650321.987654321, 1e-300],
];

describe('EWKB encoding', () => {
  it('writes a little-endian header with the SRID and Z flags', () => {
    const buf = encodeEwkb({ type: 'Point', srid: 32635, hasZ: true, coordinates: [[1, 2, 3]] });
    expect(buf[0]).toBe(1);
    const view = new DataView(buf.buffer);
    const type = view.getUint32(1, true);
    // >>> 0 throughout: JavaScript bitwise operators work on signed int32, so the 0x80000000
    // Z flag comes back negative without it. This bites everyone once.
    expect((type & EWKB_FLAG_SRID) >>> 0).toBe(EWKB_FLAG_SRID);
    expect((type & EWKB_FLAG_Z) >>> 0).toBe(EWKB_FLAG_Z);
    expect(type & 0xffff).toBe(1);
    expect(view.getUint32(5, true)).toBe(32635);
  });

  it('omits the Z flag for 2D geometry', () => {
    const buf = encodeEwkb({ type: 'Point', srid: 4326, hasZ: false, coordinates: [[1, 2]] });
    expect((new DataView(buf.buffer).getUint32(1, true) & EWKB_FLAG_Z) >>> 0).toBe(0);
  });

  it('produces the documented byte length', () => {
    expect(encodeEwkb({ type: 'Point', srid: 1, hasZ: false, coordinates: [[1, 2]] })).toHaveLength(9 + 16);
    expect(encodeEwkb({ type: 'Point', srid: 1, hasZ: true, coordinates: [[1, 2, 3]] })).toHaveLength(9 + 24);
    expect(
      encodeEwkb({ type: 'LineString', srid: 1, hasZ: false, coordinates: [[0, 0], [1, 1]] }),
    ).toHaveLength(9 + 4 + 2 * 16);
  });
});

describe('bit-exact coordinate round-trip (guardrail G2)', () => {
  it('preserves hostile full-precision coordinates exactly', () => {
    const geom: WkbGeometry = {
      type: 'LineString',
      srid: 32635,
      hasZ: true,
      coordinates: PRECISION_COORDS,
    };
    const back = decodeEwkb(encodeEwkb(geom));
    for (let i = 0; i < PRECISION_COORDS.length; i++) {
      for (let j = 0; j < 3; j++) {
        // Object.is, not toBeCloseTo. Precision is a correctness property.
        expect(Object.is(back.coordinates[i]![j]!, PRECISION_COORDS[i]![j]!)).toBe(true);
      }
    }
  });

  it('survives the hex encoding used on the wire', () => {
    const geom: WkbGeometry = { type: 'LineString', srid: 32635, hasZ: true, coordinates: PRECISION_COORDS };
    const back = decodeEwkb(fromHex(toHex(encodeEwkb(geom))));
    expect(back.coordinates).toEqual(PRECISION_COORDS);
  });

  it('round-trips arbitrary doubles bit-exactly', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ noNaN: true }), fc.double({ noNaN: true })), {
          minLength: 2,
          maxLength: 40,
        }),
        (coords) => {
          const geom: WkbGeometry = { type: 'LineString', srid: 32635, hasZ: false, coordinates: coords };
          const back = decodeEwkb(encodeEwkb(geom));
          for (let i = 0; i < coords.length; i++) {
            expect(Object.is(back.coordinates[i]![0]!, coords[i]![0]!)).toBe(true);
            expect(Object.is(back.coordinates[i]![1]!, coords[i]![1]!)).toBe(true);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('preserves subnormals, infinities and signed zero', () => {
    const nasty = [
      [Number.MIN_VALUE, -Number.MIN_VALUE],
      [Number.EPSILON, -Number.EPSILON],
      [Infinity, -Infinity],
      [-0, 0],
    ];
    const back = decodeEwkb(encodeEwkb({ type: 'LineString', srid: 1, hasZ: false, coordinates: nasty }));
    for (let i = 0; i < nasty.length; i++) {
      expect(Object.is(back.coordinates[i]![0]!, nasty[i]![0]!)).toBe(true);
      expect(Object.is(back.coordinates[i]![1]!, nasty[i]![1]!)).toBe(true);
    }
  });

  it('demonstrates why text encoding was rejected', () => {
    // ST_AsText defaults to 15 significant digits; these two distinct doubles collapse.
    const a = 4650321.104567891;
    const b = 4650321.104567892;
    expect(a).not.toBe(b);
    expect(a.toPrecision(15)).toBe(b.toPrecision(15));

    // EWKB keeps them apart.
    const decoded = decodeEwkb(
      encodeEwkb({ type: 'LineString', srid: 1, hasZ: false, coordinates: [[a, 0], [b, 0]] }),
    );
    expect(decoded.coordinates[0]![0]).not.toBe(decoded.coordinates[1]![0]);
  });
});

describe('geometry types', () => {
  it('round-trips a point', () => {
    const g: WkbGeometry = { type: 'Point', srid: 32635, hasZ: true, coordinates: [[1.5, 2.5, 3.5]] };
    expect(decodeEwkb(encodeEwkb(g))).toEqual(g);
  });

  it('round-trips a closed polygon ring', () => {
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const g: WkbGeometry = { type: 'Polygon', srid: 32635, hasZ: false, coordinates: ring };
    expect(decodeEwkb(encodeEwkb(g))).toEqual(g);
  });

  it('rejects malformed geometry with actionable errors', () => {
    expect(() => encodeEwkb({ type: 'Point', srid: 1, hasZ: false, coordinates: [] })).toThrow(/at least one/);
    expect(() =>
      encodeEwkb({ type: 'LineString', srid: 1, hasZ: false, coordinates: [[0, 0]] }),
    ).toThrow(/at least two/);
    expect(() =>
      encodeEwkb({ type: 'Polygon', srid: 1, hasZ: false, coordinates: [[0, 0], [1, 0], [1, 1], [9, 9]] }),
    ).toThrow(/must be closed/);
    expect(() =>
      encodeEwkb({ type: 'Point', srid: 1, hasZ: true, coordinates: [[0, 0]] }),
    ).toThrow(/needs 3 ordinates/);
    expect(() => encodeEwkb({ type: 'Point', srid: -1, hasZ: false, coordinates: [[0, 0]] })).toThrow(/SRID/);
  });

  it('rejects an unknown geometry type on decode', () => {
    const buf = encodeEwkb({ type: 'Point', srid: 1, hasZ: false, coordinates: [[0, 0]] });
    new DataView(buf.buffer).setUint32(1, 99 | EWKB_FLAG_SRID, true);
    expect(() => decodeEwkb(buf)).toThrow(/Unsupported WKB geometry type/);
  });
});

describe('hex helpers', () => {
  it('round-trips and tolerates the PostgreSQL bytea prefix', () => {
    const buf = new Uint8Array([0, 15, 255, 16]);
    expect(toHex(buf)).toBe('000fff10');
    expect(fromHex('000fff10')).toEqual(buf);
    expect(fromHex('\\x000fff10')).toEqual(buf);
  });

  it('rejects an odd-length hex string', () => {
    expect(() => fromHex('abc')).toThrow(/odd length/);
  });
});
