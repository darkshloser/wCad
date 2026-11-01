// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { LOD_COLUMNS, MVT_EXTENT, minFeatureSize } from '@wcad/tiling';
import { buildTileQuery, concatMvtLayers } from '../src/tileQuery.ts';

const base = {
  projectId: '1',
  layerId: '7',
  layerName: 'PARCELS',
  tileBBox: [500_000, 4_650_000, 500_100, 4_650_100] as const,
  srid: 32635,
  lod: 1 as const,
  resolution: 0.25,
  elementCap: 20_000,
};

describe('tile query construction', () => {
  it('selects the geometry column matching the requested LOD', () => {
    for (const lod of [0, 1, 2, 3] as const) {
      const { sql } = buildTileQuery({ ...base, lod });
      expect(sql).toContain(`e.${LOD_COLUMNS[lod]}`);
    }
  });

  it('parameterizes every value, interpolating only the column name', () => {
    const { sql, params } = buildTileQuery(base);
    expect(sql).not.toContain('500000');
    expect(sql).not.toContain('PARCELS');
    expect(params[0]).toBe(500_000);
    expect(params[11]).toBe('PARCELS');
  });

  it('passes the tile envelope and SRID in the expected order', () => {
    const { params } = buildTileQuery(base);
    expect(params.slice(0, 5)).toEqual([500_000, 4_650_000, 500_100, 4_650_100, 32635]);
  });

  it('derives the small-feature cull threshold from resolution', () => {
    const { params } = buildTileQuery(base);
    expect(params[9]).toBe(minFeatureSize(0.25));
    const coarse = buildTileQuery({ ...base, resolution: 100 });
    expect(coarse.params[9] as number).toBeGreaterThan(params[9] as number);
  });

  it('applies the element cap as a LIMIT', () => {
    const { sql, params } = buildTileQuery({ ...base, elementCap: 500 });
    expect(sql).toContain('LIMIT $11');
    expect(params[10]).toBe(500);
  });

  it('orders deterministically so cached tiles are byte-stable', () => {
    const { sql } = buildTileQuery(base);
    expect(sql).toContain('ORDER BY e.bbox_diag DESC, e.id ASC');
  });

  it('clips to tile geometry only after the cap is applied', () => {
    const { sql } = buildTileQuery(base);
    // ST_AsMVTGeom must run on the picked rows, not on every candidate: at low zoom the
    // difference is hundreds of thousands of discarded tile-geometry transforms per tile.
    const limitAt = sql.lastIndexOf('LIMIT $11');
    const clipAt = sql.indexOf('ST_AsMVTGeom');
    expect(limitAt).toBeGreaterThan(-1);
    expect(clipAt).toBeGreaterThan(limitAt);
  });

  it('expands block instances rather than rendering their insertion points', () => {
    const { sql } = buildTileQuery(base);
    // Principle P5: one row per placement in the table, geometry resolved at read time. Without
    // this branch an instanced drawing renders as a field of bare points.
    expect(sql).toContain('ST_Affine');
    expect(sql).toContain('block_definitions');
    expect(sql).toContain('e.transform[1]');
  });

  it('splits instanced and plain rows so neither is counted twice', () => {
    const { sql } = buildTileQuery(base);
    // A row belongs to exactly one branch, or it appears twice in the tile.
    expect(sql).toContain('e.block_id IS NULL');
    expect(sql).toContain('e.block_id IS NOT NULL');
  });

  it('matches instances on their transformed extent, not their insertion point', () => {
    const { sql } = buildTileQuery(base);
    // A symbol placed just outside the tile can still overlap it; filtering on the point alone
    // would clip symbols along every tile boundary.
    expect(sql).toContain('e.bbox && b.geom');
  });

  it('applies the transform in PostGIS ST_Affine argument order', () => {
    const { sql } = buildTileQuery(base);
    // Stored as [a, b, d, e, xoff, yoff] precisely so no reordering happens here; a permuted
    // transform still renders, just in the wrong place, which is the worst kind of wrong.
    const affine = sql.slice(sql.indexOf('ST_Affine'), sql.indexOf('ST_Affine') + 240);
    const order = [...affine.matchAll(/e\.transform\[(\d)\]/g)].map((m) => Number(m[1]));
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('uses the precomputed bbox_diag rather than a per-row function call', () => {
    const { sql } = buildTileQuery(base);
    expect(sql).toContain('e.bbox_diag');
    expect(sql).not.toContain('ST_BoundingDiagonal');
    expect(sql).not.toContain('ST_Area');
  });

  it('excludes soft-deleted rows', () => {
    expect(buildTileQuery(base).sql).toContain('e.deleted_at IS NULL');
  });

  it('scopes to one project and one layer', () => {
    const { sql, params } = buildTileQuery(base);
    expect(sql).toContain('e.project_id = $8');
    expect(sql).toContain('e.layer_id = $9');
    expect(params[7]).toBe('1');
    expect(params[8]).toBe('7');
  });

  it('defaults to the standard MVT extent and a clipping buffer', () => {
    const { params } = buildTileQuery(base);
    expect(params[5]).toBe(MVT_EXTENT);
    expect(params[6]).toBe(64);
  });

  it('produces identical SQL and params for identical input', () => {
    expect(buildTileQuery(base)).toEqual(buildTileQuery(base));
  });
});

describe('MVT layer concatenation', () => {
  it('returns an empty buffer when every layer is empty', () => {
    expect(concatMvtLayers([])).toHaveLength(0);
    expect(concatMvtLayers([new Uint8Array(0), new Uint8Array(0)])).toHaveLength(0);
  });

  it('returns the single buffer unchanged', () => {
    const one = new Uint8Array([1, 2, 3]);
    expect(concatMvtLayers([one])).toBe(one);
  });

  it('concatenates in order and drops empties', () => {
    const out = concatMvtLayers([new Uint8Array([1, 2]), new Uint8Array(0), new Uint8Array([3])]);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it('preserves total byte length', () => {
    const parts = [new Uint8Array(10).fill(7), new Uint8Array(5).fill(9)];
    expect(concatMvtLayers(parts)).toHaveLength(15);
  });
});
