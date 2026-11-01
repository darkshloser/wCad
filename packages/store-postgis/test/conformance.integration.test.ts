// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';
import { type ConformanceContext, conformanceCases } from '@wcad/store-contract';
import { createTileScheme } from '@wcad/tiling';
import { PostgresStore } from '../src/PostgresStore.ts';

/**
 * Guardrail G3: the PostGIS store must pass the IDENTICAL conformance suite as the in-memory
 * reference store, with no per-implementation exceptions.
 *
 * Runs against a real PostGIS container rather than a mock. Mocking a spatial database tests
 * nothing that matters — the interesting failures are in SRID handling, precision on the wire
 * and transaction semantics, none of which a mock reproduces.
 *
 * Excluded from the default `vitest run` because it needs Docker; run it with:
 *   pnpm vitest run --mode integration
 */

const SRID = 32635;
const EXTENT = [490_000, 4_640_000, 510_000, 4_660_000] as const;
const scheme = createTileScheme(`EPSG:${SRID}`, EXTENT, { maxZoom: 20 });

let container: StartedTestContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new GenericContainer('postgis/postgis:16-3.4')
    .withEnvironment({ POSTGRES_DB: 'wcad', POSTGRES_USER: 'wcad', POSTGRES_PASSWORD: 'test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  pool = new Pool({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    database: 'wcad',
    user: 'wcad',
    password: 'test',
  });

  const schema = readFileSync(join(process.cwd(), 'docker/postgis/init.sql'), 'utf-8');
  await pool.query(schema);
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await container?.stop().catch(() => undefined);
});

/**
 * Each case gets pristine projects so cases cannot interfere with one another.
 *
 * Returns the conformance context as well as the store: project, layer and element ids in PostGIS
 * are bigints, so the suite cannot invent them. Dropping every project between cases also drops
 * its `elements` partition, which is why ids are re-read rather than cached.
 */
async function freshStore(): Promise<{ store: PostgresStore; ctx: ConformanceContext }> {
  await pool.query('TRUNCATE elements, dirty_tiles, element_history RESTART IDENTITY CASCADE');
  await pool.query('DELETE FROM layers');
  await pool.query('DELETE FROM projects');

  const created = await pool.query('SELECT create_project($1, $2) AS id', [
    'conformance',
    `EPSG:${SRID}`,
  ]);
  const projectId = String(created.rows[0].id);

  // A second project, so "queries must not leak across projects" tests a real partition boundary.
  const other = await pool.query('SELECT create_project($1, $2) AS id', [
    'conformance-other',
    `EPSG:${SRID}`,
  ]);
  const otherProjectId = String(other.rows[0].id);

  const layerIds: string[] = [];
  for (const name of ['L0', 'LAYER_A', 'LAYER_B']) {
    const { rows } = await pool.query(
      'INSERT INTO layers (project_id, name) VALUES ($1, $2) RETURNING id::text',
      [projectId, name],
    );
    layerIds.push(rows[0].id as string);
  }
  // The other project gets its own layer too: layers are scoped per project.
  await pool.query('INSERT INTO layers (project_id, name) VALUES ($1, $2)', [otherProjectId, 'L0']);

  const ctx: ConformanceContext = {
    projectId,
    otherProjectId,
    layers: { l0: layerIds[0]!, a: layerIds[1]!, b: layerIds[2]! },
    // Well-formed for a bigint column, but far beyond any id this suite creates.
    missingElementId: '9223372036854775807',
  };

  return { store: new PostgresStore(pool, scheme, SRID), ctx };
}

describe('PostgresStore conformance', () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const { store, ctx } = await freshStore();
      await testCase.run(store, ctx);
    });
  }
});

describe('PostGIS-specific behaviour', () => {
  it('marks dirty tiles across every zoom when an element is created', async () => {
    const { store, ctx } = await freshStore();
    const projectId = ctx.projectId;

    await store.commit(projectId, [
      {
        op: 'create',
        element: {
          projectId,
          layerId: ctx.layers.l0,
          kind: 'polyline',
          crs: `EPSG:${SRID}`,
          coords: [[500_000, 4_650_000], [500_100, 4_650_100]],
        },
      },
    ]);

    const dirty = await store.takeDirtyTiles(projectId, 10_000);
    expect(dirty.length).toBeGreaterThan(0);
    expect(new Set(dirty.map((t) => t.z)).size).toBeGreaterThan(1);
  });

  it('generates a non-empty MVT tile covering drawn geometry', async () => {
    const { store, ctx } = await freshStore();
    const projectId = ctx.projectId;

    await store.commit(projectId, [
      {
        op: 'create',
        element: {
          projectId,
          layerId: ctx.layers.l0,
          kind: 'polyline',
          crs: `EPSG:${SRID}`,
          coords: [[499_000, 4_649_000], [501_000, 4_651_000]],
        },
      },
    ]);

    const tile = await store.renderTile(projectId, { z: 0, x: 0, y: 0 });
    expect(tile.length).toBeGreaterThan(0);
  });

  it('produces byte-identical tiles on repeated generation', async () => {
    const { store, ctx } = await freshStore();
    const projectId = ctx.projectId;

    for (let i = 0; i < 50; i++) {
      await store.commit(projectId, [
        {
          op: 'create',
          element: {
            projectId,
            layerId: ctx.layers.l0,
            kind: 'polyline',
            crs: `EPSG:${SRID}`,
            coords: [[499_000 + i, 4_649_000 + i], [499_500 + i, 4_649_500 + i]],
          },
        },
      ]);
    }

    // Cache correctness depends on this: a tile that varies between generations silently
    // defeats every cache tier.
    const a = await store.renderTile(projectId, { z: 2, x: 1, y: 2 });
    const b = await store.renderTile(projectId, { z: 2, x: 1, y: 2 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
