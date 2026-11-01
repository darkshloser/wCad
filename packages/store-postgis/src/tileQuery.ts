// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { BBox } from '@wcad/geo-core';
import { LOD_COLUMNS, type LodLevel, MVT_EXTENT, minFeatureSize } from '@wcad/tiling';

/**
 * ST_AsMVT tile generation (architecture doc section 5).
 *
 * One query per CAD layer. The resulting protobuf buffers are concatenated by the caller, which
 * is valid because an MVT tile is a protobuf message whose layers are a repeated field, and
 * concatenating serialized protobuf messages merges their repeated fields. That gives per-layer
 * element caps and lets the client toggle layer visibility without ever invalidating the cache.
 *
 * Ordering and culling both use the precomputed `bbox_diag` column rather than calling ST_Area
 * or ST_BoundingDiagonal per row. At 10M rows the difference between a stored double and a
 * function call per row is the difference between hitting and missing the 300 ms budget.
 */

export interface TileQueryOptions {
  readonly projectId: string;
  readonly layerId: string;
  readonly layerName: string;
  readonly tileBBox: BBox;
  readonly srid: number;
  readonly lod: LodLevel;
  /** CRS units per pixel at this zoom; drives small-feature culling. */
  readonly resolution: number;
  readonly elementCap: number;
  readonly extent?: number;
  readonly buffer?: number;
}

export interface SqlQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export function buildTileQuery(opts: TileQueryOptions): SqlQuery {
  const column = LOD_COLUMNS[opts.lod];
  const extent = opts.extent ?? MVT_EXTENT;
  const buffer = opts.buffer ?? 64;

  // The LOD column name is interpolated rather than parameterized because SQL does not allow
  // identifiers as bind parameters. It comes from LOD_COLUMNS, a frozen internal map, and never
  // from user input.
  assertKnownColumn(column);

  // Two stages, deliberately.
  //
  // `picked` selects which elements make the tile and carries the raw geometry; only then does
  // `shaped` clip and quantize it. Calling ST_AsMVTGeom in the same SELECT as the ORDER BY/LIMIT
  // lets the planner compute tile geometry for every candidate row and discard nearly all of it —
  // at low zoom that is hundreds of thousands of wasted transforms per tile, and it was the
  // dominant cost in the 10M-element benchmark.
  // Block instances are expanded here, not stored expanded (principle P5).
  //
  // An INSERT's own geometry is a single point — its placement. The geometry a user sees belongs to
  // the block definition, applied through the instance's affine transform. Resolving that with one
  // ST_Affine per instance at tile time keeps `elements` at one row per placement; materialising it
  // instead would multiply a 50,000-instance drawing by the entity count of every block.
  //
  // The instance branch matches on `bbox` rather than on the point geometry: a symbol placed just
  // outside the tile can still overlap it, and filtering by the insertion point alone would clip
  // symbols along every tile edge. `bbox` already holds the transformed block extent, computed at
  // import from all four rotated corners.
  const sql = `
    WITH bounds AS (
      SELECT ST_MakeEnvelope($1, $2, $3, $4, $5) AS geom
    ),
    picked AS (
      SELECT
        e.id::text AS id,
        e.kind AS kind,
        e.style_id AS style_id,
        e.${column} AS raw_geom
      FROM elements e
      CROSS JOIN bounds b
      WHERE e.project_id = $8
        AND e.layer_id = $9
        AND e.deleted_at IS NULL
        AND e.block_id IS NULL
        AND e.${column} IS NOT NULL
        AND e.${column} && b.geom
        AND e.bbox_diag >= $10
      ORDER BY e.bbox_diag DESC, e.id ASC
      LIMIT $11
    ),
    instanced AS (
      SELECT
        e.id::text AS id,
        e.kind AS kind,
        e.style_id AS style_id,
        ST_Affine(
          bd.geometry,
          e.transform[1], e.transform[2],
          e.transform[3], e.transform[4],
          e.transform[5], e.transform[6]
        ) AS raw_geom
      FROM elements e
      JOIN block_definitions bd ON bd.id = e.block_id
      CROSS JOIN bounds b
      WHERE e.project_id = $8
        AND e.layer_id = $9
        AND e.deleted_at IS NULL
        AND e.block_id IS NOT NULL
        AND bd.geometry IS NOT NULL
        AND e.transform IS NOT NULL
        AND e.bbox && b.geom
        AND e.bbox_diag >= $10
      ORDER BY e.bbox_diag DESC, e.id ASC
      LIMIT $11
    ),
    combined AS (
      SELECT * FROM picked
      UNION ALL
      SELECT * FROM instanced
    ),
    shaped AS (
      SELECT
        c.id,
        c.kind,
        c.style_id,
        ST_AsMVTGeom(c.raw_geom, b.geom, $6, $7, true) AS geom
      FROM combined c
      CROSS JOIN bounds b
    )
    SELECT ST_AsMVT(shaped, $12, $6, 'geom') AS tile
    FROM shaped
    WHERE shaped.geom IS NOT NULL
  `;

  return {
    sql,
    params: [
      opts.tileBBox[0],
      opts.tileBBox[1],
      opts.tileBBox[2],
      opts.tileBBox[3],
      opts.srid,
      extent,
      buffer,
      opts.projectId,
      opts.layerId,
      minFeatureSize(opts.resolution),
      opts.elementCap,
      opts.layerName,
    ],
  };
}

/**
 * Concatenates per-layer MVT buffers into one tile.
 *
 * Valid protobuf: the tile message declares `repeated Layer layers = 3`, and concatenating two
 * encoded messages is equivalent to merging them, appending repeated fields in order. Empty
 * buffers are dropped so a hidden or empty layer contributes nothing.
 */
export function concatMvtLayers(buffers: ReadonlyArray<Uint8Array>): Uint8Array {
  const parts = buffers.filter((b) => b.length > 0);
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!;

  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of parts) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

const KNOWN_COLUMNS = new Set(Object.values(LOD_COLUMNS));

function assertKnownColumn(column: string): void {
  if (!KNOWN_COLUMNS.has(column)) {
    throw new Error(`Refusing to interpolate unknown geometry column "${column}" into SQL`);
  }
}
