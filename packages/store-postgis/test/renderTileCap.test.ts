// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TILE_ELEMENT_CAP, createTileScheme } from '@wcad/tiling';
import { PostgresStore } from '../src/PostgresStore.ts';

/**
 * The element cap is a budget for the whole tile, not for each layer in it.
 *
 * Applying it per layer silently multiplies it by the layer count. On the five-layer 10M-element
 * benchmark that turned a nominal 20,000-element tile into a 100,000-element one: tiles took
 * seconds to generate and tens of milliseconds to serve even from cache, and all three Phase 2
 * budgets failed. A fake pool is enough to pin this down, because it is a question about the
 * parameters we send, not about what PostGIS does with them.
 */

const SRID = 32635;
const scheme = createTileScheme(`EPSG:${SRID}`, [490_000, 4_640_000, 510_000, 4_660_000], {
  maxZoom: 20,
});

/** Records every tile query's cap parameter. `LIMIT $11` is params[10]. */
function fakePool(layerNames: readonly string[]): { pool: Pool; caps: number[] } {
  const caps: number[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('FROM layers')) {
        return { rows: layerNames.map((name, i) => ({ id: String(i + 1), name })) };
      }
      caps.push(values![10] as number);
      return { rows: [{ tile: null }] };
    },
  };
  return { pool: pool as unknown as Pool, caps };
}

describe('tile element cap', () => {
  it('shares one budget across every layer in the tile', async () => {
    const { pool, caps } = fakePool(['PARCELS', 'BUILDINGS', 'UTILITIES', 'CONTOURS', 'ANNOTATION']);
    const store = new PostgresStore(pool, scheme, SRID);

    await store.renderTile('1', { z: 3, x: 2, y: 2 });

    expect(caps).toHaveLength(5);
    const total = caps.reduce((n, c) => n + c, 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_TILE_ELEMENT_CAP);
    // Regression: a per-layer cap would send the full budget five times over.
    expect(total).not.toBe(DEFAULT_TILE_ELEMENT_CAP * 5);
  });

  it('gives a single-layer drawing the whole budget', async () => {
    const { pool, caps } = fakePool(['PARCELS']);
    const store = new PostgresStore(pool, scheme, SRID);

    await store.renderTile('1', { z: 3, x: 2, y: 2 });

    expect(caps).toEqual([DEFAULT_TILE_ELEMENT_CAP]);
  });

  it('honours an explicit cap and still splits it', async () => {
    const { pool, caps } = fakePool(['A', 'B', 'C', 'D']);
    const store = new PostgresStore(pool, scheme, SRID);

    await store.renderTile('1', { z: 3, x: 2, y: 2 }, { elementCap: 800 });

    expect(caps).toEqual([200, 200, 200, 200]);
  });

  it('never sends a cap below one, however many layers there are', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `L${i}`);
    const { pool, caps } = fakePool(many);
    const store = new PostgresStore(pool, scheme, SRID);

    // A cap of zero would return empty tiles for every layer, which looks like data loss.
    await store.renderTile('1', { z: 3, x: 2, y: 2 }, { elementCap: 10 });

    expect(Math.min(...caps)).toBeGreaterThanOrEqual(1);
  });
});
