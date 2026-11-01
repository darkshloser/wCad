// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { parseBox2d, sridFromCrs } from '../src/projects.ts';

describe('SRID derivation', () => {
  it('extracts the numeric code', () => {
    expect(sridFromCrs('EPSG:32635')).toBe(32635);
    expect(sridFromCrs('epsg:4326')).toBe(4326);
    expect(sridFromCrs('  EPSG:7801  ')).toBe(7801);
  });

  it('refuses a local CRS rather than inventing an SRID', () => {
    // Local site systems have no EPSG code; PostGIS needs an explicit decision, not a guess.
    expect(() => sridFromCrs('local:site-A')).toThrow(/Cannot derive an SRID/);
    expect(() => sridFromCrs('')).toThrow(/Cannot derive an SRID/);
  });
});

describe('project extent parsing', () => {
  it('parses PostGIS Box2D output', () => {
    expect(parseBox2d('BOX(490000 4640000,510000 4660000)')).toEqual([490000, 4640000, 510000, 4660000]);
  });

  it('handles negative and exponent notation', () => {
    expect(parseBox2d('BOX(-1.5e2 -3,1e3 4.25)')).toEqual([-150, -3, 1000, 4.25]);
  });

  it('returns null for a missing extent so the caller can fall back', () => {
    expect(parseBox2d(null)).toBeNull();
    expect(parseBox2d('not a box')).toBeNull();
  });

  // A project holding a single point has zero area, which cannot anchor a tile pyramid —
  // createTileScheme would throw. Padding keeps a one-element project renderable.
  it('pads a degenerate extent into something a pyramid can be built on', () => {
    const bbox = parseBox2d('BOX(500000 4650000,500000 4650000)')!;
    expect(bbox[2] - bbox[0]).toBeGreaterThan(0);
    expect(bbox[3] - bbox[1]).toBeGreaterThan(0);
  });

  it('pads a zero-height extent from a perfectly horizontal line', () => {
    const bbox = parseBox2d('BOX(500000 4650000,500100 4650000)')!;
    expect(bbox[3] - bbox[1]).toBeGreaterThan(0);
  });
});
