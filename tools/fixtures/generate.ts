// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

/**
 * Fixture generator (IMPLEMENTATION-PLAN.md section 2).
 *
 * Fixtures are infrastructure, not an afterthought: without realistic large test data, the
 * tests that actually matter at scale never get written.
 *
 * Geometry is clustered rather than uniformly random. Uniform random geometry is unrealistically
 * easy on spatial indexes and produces falsely optimistic benchmarks.
 *
 *   node --experimental-strip-types tools/fixtures/generate.ts
 *   node --experimental-strip-types tools/fixtures/generate.ts --entities 10000000 --out large.dxf
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DxfWriter, type Entity } from './dxfWriter.ts';
import { defaultRegistry } from '../../packages/geo-core/src/index.ts';

const OUT_DIR = join(process.cwd(), 'fixtures');

/** Deterministic PRNG so fixtures are reproducible across machines and CI runs. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LAYERS = ['PARCELS', 'BUILDINGS', 'UTILITIES', 'CONTOURS', 'ANNOTATION'];
const ORIGIN = { x: 500_000, y: 4_650_000 };

function clusteredPoint(rnd: () => number, spread: number): [number, number] {
  // Cluster centres are themselves spread out, giving the uneven density real drawings have.
  const cluster = Math.floor(rnd() * 40);
  const cx = ORIGIN.x + ((cluster % 8) - 4) * spread;
  const cy = ORIGIN.y + (Math.floor(cluster / 8) - 2.5) * spread;
  return [cx + (rnd() - 0.5) * spread * 0.4, cy + (rnd() - 0.5) * spread * 0.4];
}

function makeEntity(rnd: () => number, spread: number): Entity {
  const layer = LAYERS[Math.floor(rnd() * LAYERS.length)]!;
  const [x, y] = clusteredPoint(rnd, spread);
  const roll = rnd();

  if (roll < 0.3) return { type: 'POINT', layer, x, y, z: rnd() * 500 };
  if (roll < 0.55) return { type: 'LINE', layer, x1: x, y1: y, x2: x + rnd() * 60 - 30, y2: y + rnd() * 60 - 30 };
  if (roll < 0.65) return { type: 'CIRCLE', layer, cx: x, cy: y, r: 1 + rnd() * 20 };
  if (roll < 0.75) {
    const start = rnd() * 360;
    return { type: 'ARC', layer, cx: x, cy: y, r: 1 + rnd() * 25, startDeg: start, endDeg: (start + 30 + rnd() * 200) % 360 };
  }
  if (roll < 0.95) {
    const n = 3 + Math.floor(rnd() * 12);
    const points: Array<[number, number]> = [];
    let px = x;
    let py = y;
    for (let i = 0; i < n; i++) {
      px += rnd() * 20 - 10;
      py += rnd() * 20 - 10;
      points.push([px, py]);
    }
    // Roughly one polyline in five carries a bulge, exercising the arc-in-polyline path.
    const bulges = rnd() < 0.2 ? points.map((_, i) => (i === 1 ? 0.4 : 0)) : undefined;
    return { type: 'LWPOLYLINE', layer, points, closed: rnd() < 0.4, ...(bulges ? { bulges } : {}) };
  }
  return { type: 'TEXT', layer: 'ANNOTATION', x, y, height: 2.5, value: `ID-${Math.floor(rnd() * 1e6)}` };
}

async function generateDxf(
  name: string,
  count: number,
  opts: { blocks?: number; seed?: number; spread?: number } = {},
): Promise<number> {
  const rnd = mulberry32(opts.seed ?? 42);
  const spread = opts.spread ?? 2000;
  const blockCount = opts.blocks ?? 0;

  const blocks = Array.from({ length: blockCount }, (_, i) => ({
    name: `SYMBOL_${i}`,
    entities: [
      { type: 'CIRCLE', layer: '0', cx: 0, cy: 0, r: 1 } as Entity,
      { type: 'LINE', layer: '0', x1: -1.5, y1: 0, x2: 1.5, y2: 0 } as Entity,
    ],
  }));

  const writer = new DxfWriter(join(OUT_DIR, name));
  await writer.begin(blocks);

  const BATCH = 20_000;
  let written = 0;
  while (written < count) {
    const size = Math.min(BATCH, count - written);
    const batch: Entity[] = new Array(size);
    for (let i = 0; i < size; i++) {
      // Principle P5: a large share of real drawings is block instances, not unique geometry.
      if (blockCount > 0 && rnd() < 0.35) {
        const [bx, by] = clusteredPoint(rnd, spread);
        batch[i] = {
          type: 'INSERT',
          layer: 'UTILITIES',
          blockName: `SYMBOL_${Math.floor(rnd() * blockCount)}`,
          x: bx,
          y: by,
          rotationDeg: Math.floor(rnd() * 360),
        };
      } else {
        batch[i] = makeEntity(rnd, spread);
      }
    }
    await writer.addMany(batch);
    written += size;
    if (count >= 1_000_000 && written % 1_000_000 === 0) {
      process.stdout.write(`  ${name}: ${(written / 1e6).toFixed(0)}M / ${(count / 1e6).toFixed(0)}M\n`);
    }
  }

  await writer.end();
  return writer.entityCount;
}

/** Hand-shaped fixture containing exactly one of every supported entity type. */
async function generateTiny(): Promise<number> {
  const writer = new DxfWriter(join(OUT_DIR, 'tiny.dxf'));
  await writer.begin([
    { name: 'MANHOLE', entities: [{ type: 'CIRCLE', layer: '0', cx: 0, cy: 0, r: 0.6 }] },
  ]);
  await writer.addMany([
    { type: 'POINT', layer: 'SURVEY', x: 500_100, y: 4_650_100, z: 123.456 },
    { type: 'LINE', layer: 'PARCELS', x1: 500_000, y1: 4_650_000, x2: 500_100, y2: 4_650_100 },
    { type: 'CIRCLE', layer: 'UTILITIES', cx: 500_050, cy: 4_650_050, r: 12.5 },
    { type: 'ARC', layer: 'UTILITIES', cx: 500_060, cy: 4_650_060, r: 8, startDeg: 0, endDeg: 90 },
    {
      type: 'LWPOLYLINE',
      layer: 'BUILDINGS',
      points: [[500_000, 4_650_000], [500_020, 4_650_000], [500_020, 4_650_015], [500_000, 4_650_015]],
      closed: true,
    },
    {
      type: 'LWPOLYLINE',
      layer: 'CONTOURS',
      points: [[500_030, 4_650_000], [500_050, 4_650_010], [500_070, 4_650_000]],
      bulges: [0.5, 0, 0],
    },
    { type: 'TEXT', layer: 'ANNOTATION', x: 500_010, y: 4_650_020, height: 2.5, value: 'PARCEL 001' },
    { type: 'INSERT', layer: 'UTILITIES', blockName: 'MANHOLE', x: 500_040, y: 4_650_040, rotationDeg: 30 },
  ]);
  await writer.end();
  return writer.entityCount;
}

/** Degenerate and hostile input. Import must survive all of it and report every rejection. */
async function generatePathological(): Promise<number> {
  const writer = new DxfWriter(join(OUT_DIR, 'pathological.dxf'));
  await writer.begin();
  await writer.addMany([
    { type: 'LINE', layer: 'DEGENERATE', x1: 10, y1: 10, x2: 10, y2: 10 },      // zero length
    { type: 'CIRCLE', layer: 'DEGENERATE', cx: 0, cy: 0, r: 0 },                 // zero radius
    { type: 'ARC', layer: 'DEGENERATE', cx: 0, cy: 0, r: 5, startDeg: 90, endDeg: 90 }, // zero sweep
    { type: 'LWPOLYLINE', layer: 'DEGENERATE', points: [[0, 0], [0, 0], [0, 0]] },      // duplicates
    { type: 'LWPOLYLINE', layer: 'DEGENERATE', points: [[0, 0], [10, 10], [0, 10], [10, 0]] }, // self-intersecting
    { type: 'POINT', layer: 'EXTREME', x: 1e15, y: -1e15, z: 1e-15 },            // near float64 limits
    { type: 'TEXT', layer: 'UNICODE', x: 0, y: 0, height: 1, value: 'Кадастър 地籍 ✓' },
    { type: 'INSERT', layer: 'MISSING', blockName: 'DOES_NOT_EXIST', x: 1, y: 1 }, // dangling reference
  ]);
  await writer.end();
  return writer.entityCount;
}

/**
 * Full-precision coordinates used by the bit-exact round-trip tests (guardrail G2).
 * If any layer of the stack rounds, reformats or float32-truncates, these values change.
 */
async function generatePrecision(): Promise<number> {
  const writer = new DxfWriter(join(OUT_DIR, 'precision.dxf'));
  await writer.begin();
  const coords: Array<[number, number]> = [
    [500123.45678901234, 4650321.104567891],
    [500123.4567890124, 4650321.104567892],
    [500123.45678901246, 4650321.1045678925],
    [0.1 + 0.2, 1e-15],
  ];
  await writer.addMany([
    { type: 'LWPOLYLINE', layer: 'PRECISION', points: coords },
    ...coords.map((c) => ({ type: 'POINT', layer: 'PRECISION', x: c[0], y: c[1], z: 12.345678901234567 }) as Entity),
  ]);
  await writer.end();
  return writer.entityCount;
}

/**
 * Reference coordinates for the TypeScript <-> Python parity test. The TypeScript registry is
 * the source of truth; pytest asserts pyproj agrees to within 1 mm.
 */
function generateCrsPoints(): number {
  const boxes: Record<string, [number, number, number, number]> = {
    'EPSG:3857': [-170, -70, 170, 70],
    'EPSG:32635': [24.5, 35, 29.5, 65],
    'EPSG:7801': [22.5, 41.3, 28.5, 44.1],
    'EPSG:27700': [-7, 50, 1.5, 58],
  };
  const rnd = mulberry32(1337);
  const systems: Record<string, Array<{ lonlat: [number, number]; projected: [number, number] }>> = {};
  let total = 0;

  for (const [code, box] of Object.entries(boxes)) {
    const entries: Array<{ lonlat: [number, number]; projected: [number, number] }> = [];
    for (let i = 0; i < 2500; i++) {
      const lon = box[0] + rnd() * (box[2] - box[0]);
      const lat = box[1] + rnd() * (box[3] - box[1]);
      const p = defaultRegistry.transform('EPSG:4326', code, [lon, lat]);
      entries.push({ lonlat: [lon, lat], projected: [p[0], p[1]] });
    }
    systems[code] = entries;
    total += entries.length;
  }

  writeFileSync(
    join(OUT_DIR, 'crs-points.json'),
    JSON.stringify({ generatedBy: '@wcad/geo-core', tolerance_m: 0.001, systems }, null, 0),
    'utf-8',
  );
  return total;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const entitiesArg = args.indexOf('--entities');
  const outArg = args.indexOf('--out');
  mkdirSync(OUT_DIR, { recursive: true });

  if (entitiesArg !== -1) {
    const count = Number(args[entitiesArg + 1]);
    const name = outArg !== -1 ? args[outArg + 1]! : `custom-${count}.dxf`;
    const started = Date.now();
    const n = await generateDxf(name, count, { blocks: Math.min(50_000, Math.floor(count / 200)) });
    console.log(`${name}: ${n.toLocaleString()} entities in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

  const manifest: Record<string, number> = {};
  manifest['tiny.dxf'] = await generateTiny();
  manifest['pathological.dxf'] = await generatePathological();
  manifest['precision.dxf'] = await generatePrecision();
  manifest['small.dxf'] = await generateDxf('small.dxf', 10_000, { blocks: 50 });
  manifest['blocks.dxf'] = await generateDxf('blocks.dxf', 100_000, { blocks: 500, seed: 7 });
  manifest['crs-points.json'] = generateCrsPoints();

  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  for (const [name, count] of Object.entries(manifest)) {
    console.log(`  ${name.padEnd(20)} ${count.toLocaleString()} entities`);
  }
  console.log('\nmedium.dxf (500k) and large.dxf (10M) are generated on demand:');
  console.log('  pnpm fixtures:generate --entities 500000  --out medium.dxf');
  console.log('  pnpm fixtures:generate --entities 10000000 --out large.dxf');
}

void main();
