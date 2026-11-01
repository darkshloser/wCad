// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Tile service benchmark — the Phase 2 exit gate, executable.
 *
 * Turns the budgets in the architecture document into pass/fail output rather than intentions:
 *
 *   tile generate (cache miss)   < 300 ms p95
 *   tile serve    (cache hit)    <  20 ms p95
 *   cache hit rate under a pan   >  90 %
 *
 * It drives the real HTTP service, so it measures the whole path — PostGIS, ST_AsMVT, both cache
 * tiers, protobuf concatenation and the network — not a unit-test approximation of it.
 *
 *   node --experimental-strip-types tools/bench/tileBench.ts
 *   node --experimental-strip-types tools/bench/tileBench.ts --url http://localhost:3001 --zooms 4,6,8
 */

import { createTileScheme, resolution, tileCount, tilesForBBox } from '@wcad/tiling';
import type { BBox } from '@wcad/geo-core';

interface ProjectInfo {
  id: string;
  name: string;
  crs: string;
  extent: BBox;
  elementCount: number;
}

interface Sample {
  readonly ms: number;
  readonly bytes: number;
  readonly cache: 'hit' | 'miss';
  readonly status: number;
}

interface Budget {
  readonly name: string;
  readonly actual: number;
  readonly limit: number;
  readonly unit: string;
  readonly comparison: 'below' | 'above';
  /**
   * False when the run produced no samples for this budget. Reporting an unmeasured budget as a
   * pass is worse than reporting a failure: a second benchmark run finds every tile already
   * cached, observes zero cache misses, and would otherwise print "generate p95 0.0 ms PASS"
   * while never having generated a tile.
   */
  readonly measured?: boolean;
  readonly note?: string;
}

const DEFAULT_URL = process.env['TILES_URL'] ?? 'http://localhost:3001';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

async function fetchTile(url: string, projectId: string, z: number, x: number, y: number): Promise<Sample> {
  const started = performance.now();
  const res = await fetch(`${url}/tiles/${projectId}/${z}/${x}/${y}.mvt`);
  const body = await res.arrayBuffer();
  return {
    ms: performance.now() - started,
    bytes: body.byteLength,
    cache: (res.headers.get('x-tile-cache') as 'hit' | 'miss') ?? 'miss',
    status: res.status,
  };
}

/**
 * Tiles covering the viewport a user would actually see, rather than random tiles.
 *
 * Random sampling across the whole pyramid overstates cache miss cost, because most of those
 * tiles are empty. A pan traverses adjacent, populated tiles, which is the case that has to be
 * fast.
 */
function viewportTiles(extent: BBox, z: number, fraction: number): Array<{ z: number; x: number; y: number }> {
  const scheme = createTileScheme('bench', extent, { maxZoom: 24 });
  const w = (extent[2] - extent[0]) * fraction;
  const h = (extent[3] - extent[1]) * fraction;
  const cx = (extent[0] + extent[2]) / 2;
  const cy = (extent[1] + extent[3]) / 2;
  const view: BBox = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  return tilesForBBox(scheme, z, view);
}

async function main(): Promise<void> {
  const url = arg('--url', DEFAULT_URL)!;
  const zooms = (arg('--zooms', '3,5,7,9') ?? '3,5,7,9').split(',').map(Number);
  const wantedProject = arg('--project');

  console.log(`tile benchmark against ${url}\n`);

  const projectsRes = await fetch(`${url}/projects`).catch(() => null);
  if (!projectsRes?.ok) {
    console.error(`Cannot reach the tile service at ${url}.`);
    console.error('Start the stack with `make up`, then seed data with `make seed`.');
    process.exit(2);
  }

  const { projects } = (await projectsRes.json()) as { projects: ProjectInfo[] };
  if (projects.length === 0) {
    console.error('The tile service has no projects. Load one with: make seed FILE=fixtures/blocks.dxf');
    process.exit(2);
  }

  const project = projects.find((p) => p.id === wantedProject) ?? projects[0]!;
  const scheme = createTileScheme(project.crs, project.extent, { maxZoom: 24 });

  console.log(`project ${project.id} "${project.name}"`);
  console.log(`  CRS       ${project.crs}`);
  console.log(`  elements  ${project.elementCount.toLocaleString()}`);
  console.log(`  extent    ${project.extent.map((v) => v.toFixed(1)).join(', ')}`);
  console.log(`  z0 tile   ${scheme.z0Size.toFixed(1)} CRS units\n`);

  const coldSamples: number[] = [];
  const warmSamples: number[] = [];
  let totalBytes = 0;
  let emptyTiles = 0;
  let errors = 0;
  let largestTile = 0;
  // Hit rate is measured from THIS run's responses, not the service's lifetime counters: those
  // include every tile the browser and any earlier benchmark already requested, so they answer a
  // different question than "did the warm pass hit the cache".
  let warmHits = 0;
  let warmRequests = 0;

  for (const z of zooms) {
    if (z > scheme.maxZoom) continue;
    const tiles = viewportTiles(project.extent, z, 0.6).slice(0, 64);
    if (tiles.length === 0) continue;

    // Cold pass: every tile is generated from PostGIS.
    const cold: number[] = [];
    for (const t of tiles) {
      const s = await fetchTile(url, project.id, t.z, t.x, t.y);
      if (s.status !== 200) {
        errors++;
        continue;
      }
      if (s.bytes === 0) emptyTiles++;
      totalBytes += s.bytes;
      largestTile = Math.max(largestTile, s.bytes);
      if (s.cache === 'miss') cold.push(s.ms);
      else warmSamples.push(s.ms);
    }

    // Warm pass: the same tiles again, now served from cache.
    const warm: number[] = [];
    for (const t of tiles) {
      const s = await fetchTile(url, project.id, t.z, t.x, t.y);
      if (s.status !== 200) {
        errors++;
        continue;
      }
      warmRequests++;
      if (s.cache === 'hit') warmHits++;
      warm.push(s.ms);
    }

    coldSamples.push(...cold);
    warmSamples.push(...warm);

    const res = resolution(scheme, z);
    console.log(
      `  z${String(z).padEnd(2)} ${String(tiles.length).padStart(3)} tiles  ` +
        `${res < 1 ? `${(res * 100).toFixed(1)} cm/px` : `${res.toFixed(2)} m/px`}  ` +
        `cold p95 ${percentile(cold, 0.95).toFixed(0).padStart(4)} ms  ` +
        `warm p95 ${percentile(warm, 0.95).toFixed(0).padStart(3)} ms`,
    );
  }

  const metrics = (await (await fetch(`${url}/metrics`)).json()) as {
    hotHits: number;
    coldHits: number;
    misses: number;
    errors: number;
    hitRate: number;
  };

  const warmHitRate = warmRequests === 0 ? 0 : (warmHits / warmRequests) * 100;

  console.log('\nsamples');
  console.log(`  cold ${coldSamples.length}, warm ${warmSamples.length}, empty tiles ${emptyTiles}, errors ${errors}`);
  console.log(`  transferred ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  largest tile ${(largestTile / 1024).toFixed(0)} KiB`);
  console.log(`  warm pass ${warmHits}/${warmRequests} served from cache`);
  console.log(
    `  service counters (lifetime, not this run): ${metrics.hotHits} hot, ${metrics.coldHits} cold, ${metrics.misses} miss`,
  );

  const budgets: Budget[] = [
    {
      name: 'Tile generate (cache miss) p95',
      actual: percentile(coldSamples, 0.95),
      limit: 300,
      unit: 'ms',
      comparison: 'below',
      measured: coldSamples.length > 0,
      note: 'every tile was already cached — flush the cache to measure generation',
    },
    {
      name: 'Tile serve (cache hit) p95',
      actual: percentile(warmSamples, 0.95),
      limit: 20,
      unit: 'ms',
      comparison: 'below',
    },
    {
      name: 'Cache hit rate (warm pass)',
      actual: warmHitRate,
      limit: 90,
      unit: '%',
      comparison: 'above',
    },
  ];

  console.log('\nbudgets');
  let failed = 0;
  for (const b of budgets) {
    const arrow = b.comparison === 'below' ? '<=' : '>=';

    if (b.measured === false) {
      failed++;
      console.log(
        `  SKIP  ${b.name.padEnd(32)} ${'not measured'.padStart(12)} (budget ${arrow} ${b.limit} ${b.unit})`,
      );
      if (b.note) console.log(`        ${b.note}`);
      continue;
    }

    const ok = b.comparison === 'below' ? b.actual <= b.limit : b.actual >= b.limit;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${b.name.padEnd(32)} ${b.actual.toFixed(1).padStart(7)} ${b.unit} ` +
        `(budget ${arrow} ${b.limit} ${b.unit})`,
    );
  }

  // Warm serve time is dominated by payload size once tiles get big: a multi-megabyte tile costs
  // tens of milliseconds to read from the cache and write to the socket, however fast the cache is.
  if (largestTile > 1024 * 1024) {
    console.log(
      `\nNote: the largest tile is ${(largestTile / 1024 / 1024).toFixed(1)} MiB. Cache-hit serve time is ` +
        'mostly payload size at that scale, so the serve budget is really a tile-size problem.\n' +
        'If these tiles predate a tiling change, flush the cache and re-run — stale tiles are ' +
        'served exactly as they were built.',
    );
  }

  if (errors > 0) {
    console.log(`\n  ${errors} requests failed — investigate before trusting these numbers.`);
    failed++;
  }

  if (project.elementCount < 100_000) {
    console.log(
      `\nNote: this project holds ${project.elementCount.toLocaleString()} elements. ` +
        'The budgets are defined at 10M. Load a larger fixture before treating a pass as meaningful:\n' +
        '  pnpm fixtures:generate --entities 10000000 --out large.dxf && make seed FILE=fixtures/large.dxf',
    );
  }

  console.log(failed === 0 ? '\nAll budgets met.' : `\n${failed} budget(s) missed.`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
