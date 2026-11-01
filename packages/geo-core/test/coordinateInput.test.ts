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
  CoordinateInputError,
  formatCoordinate,
  parseCoordinateInput,
  resolveInput,
} from '../src/input/coordinateInput.ts';
import type { Coord3 } from '../src/types.ts';

describe('typed coordinate entry', () => {
  it('parses absolute 2D and 3D input', () => {
    expect(parseCoordinateInput('100,200')).toEqual({ mode: 'absolute', point: [100, 200, 0] });
    expect(parseCoordinateInput('100,200,15')).toEqual({ mode: 'absolute', point: [100, 200, 15] });
  });

  it('accepts spaces as separators and tolerates padding', () => {
    expect(parseCoordinateInput('  100  200  15 ')).toEqual({ mode: 'absolute', point: [100, 200, 15] });
  });

  it('parses relative input', () => {
    expect(parseCoordinateInput('@10,5')).toEqual({ mode: 'relative', delta: [10, 5, 0] });
    expect(parseCoordinateInput('@10,5,2')).toEqual({ mode: 'relative', delta: [10, 5, 2] });
  });

  it('parses polar input in both relative and absolute forms', () => {
    expect(parseCoordinateInput('@50<45')).toEqual({ mode: 'polar', distance: 50, angleDeg: 45, relative: true });
    expect(parseCoordinateInput('50<45')).toEqual({ mode: 'polar', distance: 50, angleDeg: 45, relative: false });
  });

  it('handles negative, decimal and exponent ordinates', () => {
    expect(parseCoordinateInput('-1.5,+2.25')).toEqual({ mode: 'absolute', point: [-1.5, 2.25, 0] });
    expect(parseCoordinateInput('1e3,2.5e-2')).toEqual({ mode: 'absolute', point: [1000, 0.025, 0] });
    expect(parseCoordinateInput('@10<-90')).toEqual({ mode: 'polar', distance: 10, angleDeg: -90, relative: true });
  });

  it('preserves full float64 precision through parsing', () => {
    const parsed = parseCoordinateInput('500123.45678901234,4650321.104567891');
    expect(parsed).toEqual({ mode: 'absolute', point: [500123.45678901234, 4650321.104567891, 0] });
  });

  it('rejects malformed input with actionable messages', () => {
    expect(() => parseCoordinateInput('')).toThrow(CoordinateInputError);
    expect(() => parseCoordinateInput('100')).toThrow(/2 or 3 ordinates/);
    expect(() => parseCoordinateInput('1,2,3,4')).toThrow(/2 or 3 ordinates/);
    expect(() => parseCoordinateInput('abc,def')).toThrow(/not a finite number/);
    expect(() => parseCoordinateInput('@')).toThrow(/after "@"/);
    expect(() => parseCoordinateInput('50<')).toThrow(/Malformed polar/);
    expect(() => parseCoordinateInput('@-5<45')).toThrow(/must not be negative/);
  });

  it('resolves relative input against the previous point', () => {
    expect(resolveInput(parseCoordinateInput('@10,5,2'), [1, 2, 3])).toEqual([11, 7, 5]);
  });

  it('resolves polar input to the expected offset', () => {
    const p = resolveInput(parseCoordinateInput('@10<90'), [5, 5, 1]);
    expect(p[0]).toBeCloseTo(5, 9);
    expect(p[1]).toBeCloseTo(15, 9);
    expect(p[2]).toBe(1);
  });

  it('requires a previous point for every relative form', () => {
    expect(() => resolveInput(parseCoordinateInput('@1,1'), null)).toThrow(/previous point/);
    expect(() => resolveInput(parseCoordinateInput('@1<0'), null)).toThrow(/previous point/);
  });

  // Typed entry and mouse entry must be interchangeable, so a formatted point must parse back
  // to the same point.
  it('round-trips absolute points through format and parse', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (x, y) => {
          const text = `${x},${y}`;
          const parsed = parseCoordinateInput(text);
          const p = resolveInput(parsed, null);
          // Numeric equality rather than deep equality: JavaScript renders -0 as "0", so the
          // sign of zero cannot survive a text round trip. Geometrically -0 and +0 are the
          // same point, so === is the correct comparison here even though coordinate storage
          // elsewhere is asserted bit-exactly with Object.is.
          expect(p[0] === x).toBe(true);
          expect(p[1] === y).toBe(true);
          expect(p[2]).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('produces relative deltas that invert exactly', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (dx, dy) => {
          const last: Coord3 = [100, 200, 5];
          const forward = resolveInput(parseCoordinateInput(`@${dx},${dy}`), last);
          const back = resolveInput(parseCoordinateInput(`@${-dx},${-dy}`), forward);
          expect(back[0]).toBeCloseTo(last[0], 9);
          expect(back[1]).toBeCloseTo(last[1], 9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('treats negative zero as the same point as positive zero', () => {
    const p = resolveInput(parseCoordinateInput('-0,0'), null);
    expect(p[0] === 0).toBe(true);
    expect(Object.is(p[0], -0)).toBe(true); // Number('-0') does preserve the sign
    expect(resolveInput(parseCoordinateInput(`${-0},0`), null)[0]).toBe(0); // but formatting does not
  });

  it('formats using the active CRS axis labels rather than hardcoded X/Y', () => {
    expect(formatCoordinate([1.23456, 2.5, 3], ['N', 'E', 'H'], 2)).toBe('N 1.23  E 2.50  H 3.00');
    expect(formatCoordinate([1, 2, 3], ['Lon', 'Lat', 'H'], 0)).toBe('Lon 1  Lat 2  H 3');
  });
});
