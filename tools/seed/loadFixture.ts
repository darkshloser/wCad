// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Bulk fixture loader (IMPLEMENTATION-PLAN.md section 6, step 2).
 *
 * A direct path into PostGIS so the Phase 2 read path can be measured against realistic data
 * before the real import pipeline exists. It streams the DXF rather than reading it, for the
 * same reason the production importer will: a 10M-entity file must never be materialized in
 * memory.
 *
 * IMPORTANT — this is a BENCHMARK loader, not the production import path. It writes geometry as
 * WKT because that is far faster to build in bulk, and WKT is not bit-exact for float64
 * (guardrail G2). That is acceptable here because fixture coordinates are synthetic and only
 * ever used to measure rendering. Real imports go through the Python worker in Phase 3, and
 * interactive writes go through PostgresStore, which uses EWKB precisely so nothing rounds.
 * Never point this script at customer data.
 *
 *   node --experimental-strip-types tools/seed/loadFixture.ts --file fixtures/small.dxf
 *   node --experimental-strip-types tools/seed/loadFixture.ts --file fixtures/large.dxf --project Big
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { LOD_TOLERANCES, simplify } from '@wcad/geo-core';
import type { Coord2, ElementKind } from '@wcad/geo-core';
import { kindToCode } from '@wcad/store-contract';

const BATCH_SIZE = 10_000;

/** Bind parameters per row in the multi-row INSERT below. Update together with the statement. */
export const PARAMS_PER_ROW = 9;

/**
 * PostgreSQL's Bind message stores the parameter count as a signed 16-bit integer, so 65535 is a
 * hard protocol limit rather than a tunable.
 *
 * Exceeding it does not produce a clear "too many parameters" error: the count silently wraps.
 * A 10,000-row batch sends 90,000 parameters, which arrives as 90000 - 65536 = 24464, and the
 * server reports the baffling "bind message has 24464 parameter formats but 0 parameters".
 *
 * So the statement is chunked by parameter count, not by row count — the safe row count changes
 * whenever a column is added, and deriving it here means that can never be forgotten.
 */
export const MAX_BIND_PARAMS = 65_535;
export const MAX_ROWS_PER_STATEMENT = Math.floor(MAX_BIND_PARAMS / PARAMS_PER_ROW);

export interface ParsedEntity {
  readonly kind: ElementKind;
  readonly layer: string;
  readonly coords: number[][];
  readonly params?: Record<string, number>;
}

/**
 * Streaming DXF reader.
 *
 * ASCII DXF is a flat sequence of (group code, value) line pairs, so a streaming tokenizer needs
 * no lookahead and no document model. Deliberately minimal: it handles what the fixture
 * generator emits. The production importer is `ezdxf.iterdxf`, which copes with the far stranger
 * things real files contain.
 */
export async function* readEntities(path: string): AsyncGenerator<ParsedEntity> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf-8' }), crlfDelay: Infinity });

  let code: number | null = null;
  let inEntities = false;
  let type: string | null = null;
  let fields = new Map<number, string[]>();

  const flush = (): ParsedEntity | null => {
    if (!type) return null;
    const entity = buildEntity(type, fields);
    type = null;
    fields = new Map();
    return entity;
  };

  for await (const raw of rl) {
    const line = raw.trim();
    if (code === null) {
      const parsed = Number(line);
      code = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    const value = line;
    const groupCode = code;
    code = null;

    if (groupCode === 0) {
      if (value === 'SECTION') continue;
      if (value === 'ENDSEC') {
        const done = flush();
        if (done) yield done;
        inEntities = false;
        continue;
      }
      const done = flush();
      if (done) yield done;
      if (inEntities) type = value;
      continue;
    }

    if (groupCode === 2 && !inEntities && value === 'ENTITIES') {
      inEntities = true;
      continue;
    }

    if (type) {
      const list = fields.get(groupCode) ?? [];
      list.push(value);
      fields.set(groupCode, list);
    }
  }

  const last = flush();
  if (last) yield last;
}

function nums(fields: Map<number, string[]>, code: number): number[] {
  return (fields.get(code) ?? []).map(Number);
}

export function buildEntity(type: string, fields: Map<number, string[]>): ParsedEntity | null {
  const layer = fields.get(8)?.[0] ?? '0';
  const xs = nums(fields, 10);
  const ys = nums(fields, 20);
  const zs = nums(fields, 30);

  const pts = (): number[][] =>
    xs.map((x, i) => (zs[i] !== undefined ? [x, ys[i] ?? 0, zs[i]!] : [x, ys[i] ?? 0]));

  switch (type) {
    case 'POINT':
    case 'TEXT':
    case 'INSERT': {
      if (xs.length === 0) return null;
      const kind: ElementKind = type === 'POINT' ? 'point' : type === 'TEXT' ? 'text' : 'insert';
      return { kind, layer, coords: [pts()[0]!] };
    }
    case 'LINE': {
      const x2 = nums(fields, 11)[0];
      const y2 = nums(fields, 21)[0];
      if (xs.length === 0 || x2 === undefined) return null;
      return { kind: 'line', layer, coords: [[xs[0]!, ys[0] ?? 0], [x2, y2 ?? 0]] };
    }
    case 'LWPOLYLINE': {
      const coords = pts();
      if (coords.length < 2) return null;
      return { kind: 'polyline', layer, coords };
    }
    case 'CIRCLE': {
      const r = nums(fields, 40)[0];
      if (xs.length === 0 || r === undefined || !(r > 0)) return null;
      return {
        kind: 'circle',
        layer,
        coords: tessellateCircle(xs[0]!, ys[0] ?? 0, r),
        params: { cx: xs[0]!, cy: ys[0] ?? 0, r },
      };
    }
    case 'ARC': {
      const r = nums(fields, 40)[0];
      const start = nums(fields, 50)[0];
      const end = nums(fields, 51)[0];
      if (xs.length === 0 || r === undefined || !(r > 0) || start === undefined || end === undefined) return null;
      const s = (start * Math.PI) / 180;
      const e = (end * Math.PI) / 180;
      return {
        kind: 'arc',
        layer,
        coords: tessellateArc(xs[0]!, ys[0] ?? 0, r, s, e),
        // The canonical parametric definition, which is what precision-sensitive code reads (P1).
        params: { cx: xs[0]!, cy: ys[0] ?? 0, r, startAngle: s, endAngle: e, ccw: 1 },
      };
    }
    default:
      return null;
  }
}

function tessellateCircle(cx: number, cy: number, r: number, segments = 64): number[][] {
  const out: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

function tessellateArc(cx: number, cy: number, r: number, start: number, end: number, segments = 32): number[][] {
  let sweep = end - start;
  while (sweep <= 0) sweep += Math.PI * 2;
  const out: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = start + (sweep * i) / segments;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

export function minVertices(kind: ElementKind): number {
  if (kind === 'polygon') return 3;
  if (kind === 'point' || kind === 'text' || kind === 'insert') return 1;
  return 2;
}

export function toWkt(kind: ElementKind, coords: readonly Coord2[]): string {
  if (kind === 'point' || kind === 'text' || kind === 'insert' || coords.length < 2) {
    return `POINT(${coords[0]![0]} ${coords[0]![1]})`;
  }
  const pairs = coords.map((c) => `${c[0]} ${c[1]}`).join(', ');
  if (kind === 'polygon') {
    const first = coords[0]!;
    const last = coords[coords.length - 1]!;
    const closed = first[0] === last[0] && first[1] === last[1] ? pairs : `${pairs}, ${first[0]} ${first[1]}`;
    return `POLYGON((${closed}))`;
  }
  return `LINESTRING(${pairs})`;
}

export function bounds(coords: readonly Coord2[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of coords) {
    if (c[0] < minX) minX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] > maxY) maxY = c[1];
  }
  return [minX, minY, maxX, maxY];
}

/** Minimal surface of `pg.Pool` used here, so tests can drive this with a fake. */
export interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export async function insertBatch(
  pool: QueryablePool,
  projectId: string,
  srid: number,
  batch: ReadonlyArray<{ entity: ParsedEntity; layerId: string }>,
): Promise<void> {
  // Split into statements that stay under the protocol's parameter ceiling. See MAX_BIND_PARAMS.
  for (let start = 0; start < batch.length; start += MAX_ROWS_PER_STATEMENT) {
    await insertChunk(pool, projectId, srid, batch.slice(start, start + MAX_ROWS_PER_STATEMENT));
  }
}

async function insertChunk(
  pool: QueryablePool,
  projectId: string,
  srid: number,
  batch: ReadonlyArray<{ entity: ParsedEntity; layerId: string }>,
): Promise<void> {
  if (batch.length === 0) return;
  const values: unknown[] = [];
  const tuples: string[] = [];

  batch.forEach(({ entity, layerId }, i) => {
    const xy: Coord2[] = entity.coords.map((c) => [c[0]!, c[1]!]);
    const wkt = toWkt(entity.kind, xy);
    const lods = LOD_TOLERANCES.map((tolerance) => {
      const s = simplify(xy, tolerance);
      return s.length >= minVertices(entity.kind) ? toWkt(entity.kind, s) : null;
    });
    const bbox = bounds(xy);
    const b = i * PARAMS_PER_ROW;
    tuples.push(
      `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4},` +
        ` ST_GeomFromText($${b + 5}, $${b + 4}),` +
        ` CASE WHEN $${b + 6}::text IS NULL THEN NULL ELSE ST_GeomFromText($${b + 6}, $${b + 4}) END,` +
        ` CASE WHEN $${b + 7}::text IS NULL THEN NULL ELSE ST_GeomFromText($${b + 7}, $${b + 4}) END,` +
        ` CASE WHEN $${b + 8}::text IS NULL THEN NULL ELSE ST_GeomFromText($${b + 8}, $${b + 4}) END,` +
        ` Box2D(ST_GeomFromText($${b + 5}, $${b + 4})), $${b + 9})`,
    );
    values.push(
      projectId,
      layerId,
      kindToCode(entity.kind),
      srid,
      wkt,
      lods[0],
      lods[1],
      lods[2],
      Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]),
    );
  });

  await pool.query(
    `INSERT INTO elements
       (project_id, layer_id, kind, srid, geom, geom_lod1, geom_lod2, geom_lod3, bbox, bbox_diag)
     VALUES ${tuples.join(', ')}`,
    values,
  );
}

function valueOf(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = valueOf(args, '--file') ?? 'fixtures/small.dxf';
  const projectName = valueOf(args, '--project') ?? `seed:${file}`;
  const srid = Number(valueOf(args, '--srid') ?? 32635);

  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  const started = Date.now();

  const { rows } = await pool.query('SELECT create_project($1, $2) AS id', [projectName, `EPSG:${srid}`]);
  const projectId = String(rows[0].id);
  console.log(`project ${projectId} (${projectName})`);

  const layerIds = new Map<string, string>();
  const layerId = async (name: string): Promise<string> => {
    const known = layerIds.get(name);
    if (known) return known;
    const res = await pool.query(
      `INSERT INTO layers (project_id, name) VALUES ($1, $2)
       ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id::text`,
      [projectId, name],
    );
    const id = res.rows[0].id as string;
    layerIds.set(name, id);
    return id;
  };

  let batch: Array<{ entity: ParsedEntity; layerId: string }> = [];
  let stored = 0;
  let parsed = 0;
  let unsupported = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    await insertBatch(pool, projectId, srid, batch);
    stored += batch.length;
    batch = [];
    if (stored % 100_000 === 0) console.log(`  ${stored.toLocaleString()} entities`);
  };

  for await (const entity of readEntities(file)) {
    parsed++;
    batch.push({ entity, layerId: await layerId(entity.layer) });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  // Record the project extent. The tile service derives each project's tile pyramid from this
  // row, so a project without an extent cannot be tiled at all.
  await pool.query(
    `UPDATE projects
        SET extent = (SELECT ST_Extent(geom) FROM elements WHERE project_id = $1)
      WHERE id = $1`,
    [projectId],
  );

  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS n,
            Box2D((SELECT extent FROM projects WHERE id = $1)::geometry)::text AS extent_text
       FROM elements WHERE project_id = $1`,
    [projectId],
  );
  const inDb = countRows[0].n as number;
  console.log(`extent ${countRows[0].extent_text}`);

  // Nudge a running tile service to forget its cached scheme for this project.
  const tilesUrl = process.env['TILES_URL'];
  if (tilesUrl) {
    await fetch(`${tilesUrl}/admin/refresh`, { method: 'GET' })
      .then(() => console.log('tile service project cache refreshed'))
      .catch(() => console.log('tile service not reachable; restart it to pick up the new project'));
  }

  console.log(`parsed ${parsed.toLocaleString()}, stored ${stored.toLocaleString()} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`database contains ${inDb.toLocaleString()}, unsupported ${unsupported}`);
  console.log(`\nproject id ${projectId} — open http://localhost:5173/?project=${projectId}`);

  // Reconciliation, the same discipline the production importer uses: nothing may vanish
  // silently between the file and the database.
  if (inDb !== stored) {
    console.error('RECONCILIATION FAILED: parsed and stored counts differ');
    process.exitCode = 1;
  }

  await pool.end();
}

if (process.argv[1]?.endsWith('loadFixture.ts')) {
  void main();
}
