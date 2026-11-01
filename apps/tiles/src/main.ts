// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { createServer, type ServerResponse } from 'node:http';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PostgresStore } from '@wcad/store-postgis';
import { type TileScheme, tileKey } from '@wcad/tiling';
import { TileCache } from './cache.ts';
import { ProjectRegistry } from './projects.ts';
import { FilesystemTier, ValkeyTier } from './tiers.ts';

/**
 * Tile service (architecture doc section 5).
 *
 * Deployed separately from the API so heavy read traffic cannot starve edit traffic, and reads
 * from a PostgreSQL replica when one is configured. Stateless, so it scales by replica count.
 *
 * The tile scheme for each project is derived from that project's stored extent, not from
 * configuration — see `projects.ts` for why.
 */

const PORT = Number(process.env['PORT'] ?? 3001);
const DATABASE_URL = process.env['DATABASE_URL_REPLICA'] ?? process.env['DATABASE_URL'] ?? '';
const VALKEY_URL = process.env['VALKEY_URL'] ?? 'redis://valkey:6379';
const TILE_CACHE_PATH = process.env['TILE_CACHE_PATH'] ?? '/var/lib/wcad/objects/tiles';

/** Only used for projects that contain no geometry yet and therefore have no extent. */
const FALLBACK_EXTENT: [number, number, number, number] = [
  Number(process.env['PROJECT_MIN_X'] ?? 490_000),
  Number(process.env['PROJECT_MIN_Y'] ?? 4_640_000),
  Number(process.env['PROJECT_MAX_X'] ?? 510_000),
  Number(process.env['PROJECT_MAX_Y'] ?? 4_660_000),
];

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const valkey = new Redis(VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const registry = new ProjectRegistry(pool, FALLBACK_EXTENT);

const cache = new TileCache(new ValkeyTier(valkey), new FilesystemTier(TILE_CACHE_PATH), {
  async generate(key) {
    const parsed = parseKey(key);
    if (!parsed) return new Uint8Array(0);
    const project = await registry.get(parsed.projectId);
    if (!project) return new Uint8Array(0);

    const store = new PostgresStore(pool, project.scheme, project.info.srid);
    return store.renderTile(
      parsed.projectId,
      parsed.tile,
      parsed.layerIds ? { layerIds: parsed.layerIds } : {},
    );
  },
});

const TILE_ROUTE = /^\/tiles\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.mvt$/;

const server = createServer(async (req, res) => {
  const started = performance.now();
  const url = new URL(req.url ?? '/', 'http://localhost');

  // CORS: the Vite dev server runs on a different port from the tile service.
  res.setHeader('access-control-allow-origin', process.env['CORS_ORIGIN'] ?? '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname === '/health') {
      await pool.query('SELECT 1');
      return json(res, 200, { status: 'ok', service: 'tiles' });
    }

    if (url.pathname === '/metrics') {
      return json(res, 200, {
        ...cache.stats,
        hitRate: Number(cache.hitRate.toFixed(4)),
      });
    }

    /**
     * Project discovery. The client reads its project id, CRS and extent from here and builds
     * an identical tile grid, rather than hardcoding values that would silently drift.
     */
    if (url.pathname === '/projects') {
      return json(res, 200, { projects: await registry.list() });
    }

    if (url.pathname === '/admin/refresh') {
      registry.invalidate();
      return json(res, 200, { status: 'project cache cleared' });
    }

    const match = TILE_ROUTE.exec(url.pathname);
    if (!match) return json(res, 404, { error: 'Not found' });

    const projectId = match[1]!;
    const tile = { z: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
    const layerIds = url.searchParams.get('layers')?.split(',').filter(Boolean);

    const project = await registry.get(projectId);
    if (!project) return json(res, 404, { error: `Unknown project ${projectId}` });

    // Evict anything the write path marked dirty before serving, so an edit is never served
    // stale. Rebuild stays lazy — this only removes entries.
    await drainDirty(projectId, project.info.srid, project.scheme);

    const key = tileKey(projectId, tile, layerIds);
    const before = cache.stats.hotHits + cache.stats.coldHits;
    const body = await cache.get(key);
    const wasHit = cache.stats.hotHits + cache.stats.coldHits > before;
    const elapsed = performance.now() - started;

    res.writeHead(200, {
      'content-type': 'application/vnd.mapbox-vector-tile',
      'content-length': String(body.length),
      'cache-control': 'public, max-age=3600',
      // Read by the benchmark harness so cache behaviour is measurable from outside.
      'x-tile-ms': elapsed.toFixed(2),
      'x-tile-cache': wasHit ? 'hit' : 'miss',
      'x-tile-bytes': String(body.length),
    });
    res.end(Buffer.from(body));
  } catch (err) {
    console.error('[tiles] request failed', err);
    json(res, 500, { error: 'Tile generation failed', detail: (err as Error).message });
  }
});

const dirtyDrainedAt = new Map<string, number>();

/** Throttled: draining on every tile request would hammer the write table during a pan. */
async function drainDirty(projectId: string, srid: number, scheme: TileScheme): Promise<void> {
  const last = dirtyDrainedAt.get(projectId) ?? 0;
  if (Date.now() - last < 250) return;
  dirtyDrainedAt.set(projectId, Date.now());

  const store = new PostgresStore(pool, scheme, srid);
  const tiles = await store.takeDirtyTiles(projectId, 2000);
  if (tiles.length === 0) return;
  await cache.invalidateMany(tiles.map((t) => tileKey(projectId, t)));
}

export function parseKey(
  key: string,
): { projectId: string; tile: { z: number; x: number; y: number }; layerIds?: string[] } | null {
  const [path, query] = key.split('?');
  const parts = path!.split('/');
  if (parts.length !== 4) return null;
  const layers = query?.startsWith('l=') ? query.slice(2).split(',') : undefined;
  return {
    projectId: parts[0]!,
    tile: { z: Number(parts[1]), x: Number(parts[2]), y: Number(parts[3]) },
    ...(layers ? { layerIds: layers } : {}),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

server.listen(PORT, () => {
  console.log(`[tiles] listening on :${PORT} (cache ${TILE_CACHE_PATH})`);
});
