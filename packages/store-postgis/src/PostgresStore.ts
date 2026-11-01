// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { Pool, PoolClient } from 'pg';
import type { BBox, ElementKind } from '@wcad/geo-core';
import {
  type Change,
  type CommitResult,
  type Conflict,
  type ElementRecord,
  type GeometryStore,
  type NewElement,
  type QueryOptions,
  type SnapVertex,
  codeToKind,
  kindToCode,
} from '@wcad/store-contract';
import {
  DEFAULT_TILE_ELEMENT_CAP,
  type TileCoord,
  type TileScheme,
  dirtyTilesForEdit,
  resolution,
  selectLodForZoom,
  tileBBox,
} from '@wcad/tiling';
import { bboxDiagonal, buildLodGeometries, computeBBox, toWkbGeometry } from './geometryMapping.ts';
import { buildTileQuery, concatMvtLayers } from './tileQuery.ts';
import { decodeEwkb, encodeEwkb, fromHex, toHex } from './wkb.ts';

/**
 * PostGIS-backed GeometryStore (architecture doc section 4).
 *
 * Passes the same conformance suite as the in-memory reference store and the future
 * SQLite-WASM store (guardrail G3) — that equivalence is what makes local and server projects
 * one feature rather than two products.
 *
 * All geometry crosses the wire as EWKB hex rather than WKT, so float64 coordinates round-trip
 * bit-exactly (guardrail G2). See `wkb.ts` for why text encoding was rejected.
 */
export class PostgresStore implements GeometryStore {
  readonly name = 'postgis';

  // Explicit fields, not constructor parameter properties: this package is imported by services
  // and tools that run under `node --experimental-strip-types`, which erases type annotations
  // without generating code, and a parameter property requires a generated assignment.
  readonly #pool: Pool;
  readonly #scheme: TileScheme;
  readonly #srid: number;

  constructor(pool: Pool, scheme: TileScheme, srid: number) {
    this.#pool = pool;
    this.#scheme = scheme;
    this.#srid = srid;
  }

  async getExact(ids: readonly string[]): Promise<ElementRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.#pool.query(
      `SELECT id::text, project_id::text, layer_id::text, kind, srid, params, version,
              encode(ST_AsEWKB(geom), 'hex') AS geom_hex,
              z_values,
              Box2D(geom)::text AS bbox_text
         FROM elements
        WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`,
      [ids],
    );
    return rows.map(rowToRecord);
  }

  async queryBBox(projectId: string, bbox: BBox, opts: QueryOptions = {}): Promise<ElementRecord[]> {
    const params: unknown[] = [projectId, bbox[0], bbox[1], bbox[2], bbox[3], this.#srid];
    let sql = `
      SELECT id::text, project_id::text, layer_id::text, kind, srid, params, version,
             encode(ST_AsEWKB(geom), 'hex') AS geom_hex,
             z_values,
             Box2D(geom)::text AS bbox_text
        FROM elements
       WHERE project_id = $1
         AND deleted_at IS NULL
         AND geom && ST_MakeEnvelope($2, $3, $4, $5, $6)`;

    if (opts.layerIds && opts.layerIds.length > 0) {
      params.push(opts.layerIds);
      sql += ` AND layer_id = ANY($${params.length}::bigint[])`;
    }
    // Deterministic ordering so repeated queries return identical results.
    sql += ' ORDER BY id ASC';
    if (opts.limit !== undefined) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const { rows } = await this.#pool.query(sql, params);
    return rows.map(rowToRecord);
  }

  /**
   * Bounded, proximity-ordered exact vertices (architecture doc section 6.2).
   *
   * ST_DumpPoints returns authoritative float64 vertices, never generalized or quantized
   * geometry — snapping to a tile coordinate would violate principle P1 and silently corrupt
   * drawings. The LIMIT is what keeps this bounded on a dense drawing.
   */
  async snapCandidates(projectId: string, bbox: BBox, limit: number): Promise<SnapVertex[]> {
    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    const { rows } = await this.#pool.query(
      `WITH bounds AS (SELECT ST_MakeEnvelope($2, $3, $4, $5, $6) AS g),
            candidates AS (
              SELECT e.id::text AS element_id, dp.path[1] AS idx,
                     ST_NPoints(e.geom) AS n, dp.geom AS pt
                FROM elements e
                CROSS JOIN bounds b
                CROSS JOIN LATERAL ST_DumpPoints(e.geom) dp
               WHERE e.project_id = $1
                 AND e.deleted_at IS NULL
                 AND e.geom && b.g
                 AND ST_Intersects(dp.geom, b.g)
            )
       SELECT element_id, idx, n,
              ST_X(pt) AS x, ST_Y(pt) AS y, ST_Z(pt) AS z
         FROM candidates
        ORDER BY ((ST_X(pt) - $7) ^ 2 + (ST_Y(pt) - $8) ^ 2) ASC, element_id ASC, idx ASC
        LIMIT $9`,
      [projectId, bbox[0], bbox[1], bbox[2], bbox[3], this.#srid, cx, cy, limit],
    );

    return rows.map((r): SnapVertex => ({
      elementId: r.element_id as string,
      x: Number(r.x),
      y: Number(r.y),
      z: r.z === null ? undefined : Number(r.z),
      role: r.idx === 1 || r.idx === r.n ? 'endpoint' : 'vertex',
    }));
  }

  async getMetadata(id: string): Promise<Readonly<Record<string, unknown>> | undefined> {
    const { rows } = await this.#pool.query(
      'SELECT metadata FROM elements WHERE id = $1::bigint AND deleted_at IS NULL',
      [id],
    );
    return (rows[0]?.metadata as Record<string, unknown> | null) ?? undefined;
  }

  /**
   * Atomic optimistic-concurrency commit.
   *
   * Every version is checked before anything is written, inside one transaction. A single stale
   * element rolls the whole batch back — a user action is all-or-nothing, so a move that touches
   * twenty elements can never half-apply.
   */
  async commit(projectId: string, changes: readonly Change[]): Promise<CommitResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      const conflicts = await this.#checkVersions(client, changes);
      if (conflicts.length > 0) {
        await client.query('ROLLBACK');
        return { ok: false, conflicts };
      }

      const ids: string[] = [];
      const versions: number[] = [];
      const dirty: TileCoord[] = [];

      for (const change of changes) {
        const result = await this.#applyChange(client, projectId, change);
        ids.push(result.id);
        versions.push(result.version);
        dirty.push(...result.dirtyTiles);
      }

      await this.#markDirty(client, projectId, dirty);
      await client.query('COMMIT');
      return { ok: true, ids, versions };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async count(projectId: string): Promise<number> {
    const { rows } = await this.#pool.query(
      'SELECT count(*)::int AS n FROM elements WHERE project_id = $1 AND deleted_at IS NULL',
      [projectId],
    );
    return rows[0]?.n ?? 0;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  /** Renders one MVT tile, one protobuf layer per CAD layer. */
  async renderTile(
    projectId: string,
    tile: TileCoord,
    opts: { layerIds?: readonly string[]; elementCap?: number } = {},
  ): Promise<Uint8Array> {
    const bounds = tileBBox(this.#scheme, tile);
    const lod = selectLodForZoom(this.#scheme, tile.z);
    const res = resolution(this.#scheme, tile.z);
    const cap = opts.elementCap ?? DEFAULT_TILE_ELEMENT_CAP;

    const layers = await this.#layers(projectId, opts.layerIds);
    const buffers: Uint8Array[] = [];

    // The cap is a budget for the WHOLE tile, so it is shared across layers rather than applied
    // to each one. Applying it per layer multiplies it by the layer count: on a five-layer
    // drawing a "20,000 element" tile actually carried 100,000, which at low zoom produced
    // multi-megabyte tiles that were slow to build and slow to serve even from cache.
    //
    // An equal split is deliberately simple. It can waste budget when one layer is empty and
    // another is dense; a proportional allocation would need a counting pass per layer, which
    // costs more than it saves at this scale.
    const perLayerCap = Math.max(1, Math.floor(cap / Math.max(1, layers.length)));

    for (const layer of layers) {
      const { sql, params } = buildTileQuery({
        projectId,
        layerId: layer.id,
        layerName: layer.name,
        tileBBox: bounds,
        srid: this.#srid,
        lod,
        resolution: res,
        elementCap: perLayerCap,
      });
      const { rows } = await this.#pool.query(sql, [...params]);
      const raw = (rows[0] as { tile?: Buffer } | undefined)?.tile ?? null;
      if (raw && raw.length > 0) buffers.push(new Uint8Array(raw));
    }

    return concatMvtLayers(buffers);
  }

  /** Tiles awaiting rebuild. The tile service evicts these lazily rather than eagerly. */
  async takeDirtyTiles(projectId: string, limit = 1000): Promise<TileCoord[]> {
    const { rows } = await this.#pool.query(
      `DELETE FROM dirty_tiles
        WHERE ctid IN (
          SELECT ctid FROM dirty_tiles WHERE project_id = $1 ORDER BY marked_at ASC LIMIT $2
        )
        RETURNING z, x, y`,
      [projectId, limit],
    );
    return rows.map((r) => ({ z: r.z as number, x: r.x as number, y: r.y as number }));
  }

  async #layers(projectId: string, layerIds?: readonly string[]): Promise<Array<{ id: string; name: string }>> {
    const params: unknown[] = [projectId];
    let sql = 'SELECT id::text, name FROM layers WHERE project_id = $1 AND visible';
    if (layerIds && layerIds.length > 0) {
      params.push(layerIds);
      sql += ` AND id = ANY($${params.length}::bigint[])`;
    }
    sql += ' ORDER BY priority ASC, id ASC';
    const { rows } = await this.#pool.query(sql, params);
    return rows.map((r) => ({ id: r.id as string, name: r.name as string }));
  }

  async #checkVersions(client: PoolClient, changes: readonly Change[]): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];
    for (const change of changes) {
      if (change.op === 'create') continue;
      // FOR UPDATE so a concurrent committer cannot slip in between the check and the write.
      const { rows } = await client.query(
        'SELECT version FROM elements WHERE id = $1::bigint AND deleted_at IS NULL FOR UPDATE',
        [change.id],
      );
      const actual = rows[0]?.version as number | undefined;
      if (actual === undefined) {
        conflicts.push({ id: change.id, expectedVersion: change.baseVersion, actualVersion: 0 });
      } else if (actual !== change.baseVersion) {
        conflicts.push({ id: change.id, expectedVersion: change.baseVersion, actualVersion: actual });
      }
    }
    return conflicts;
  }

  async #applyChange(
    client: PoolClient,
    projectId: string,
    change: Change,
  ): Promise<{ id: string; version: number; dirtyTiles: TileCoord[] }> {
    if (change.op === 'delete') {
      const { rows } = await client.query(
        `UPDATE elements SET deleted_at = now(), version = version + 1
          WHERE id = $1::bigint RETURNING Box2D(geom)::text AS bbox_text`,
        [change.id],
      );
      const before = rows[0] ? parseBox2d(rows[0].bbox_text as string) : null;
      return {
        id: change.id,
        version: 0,
        dirtyTiles: [...dirtyTilesForEdit(this.#scheme, before, null).tiles],
      };
    }

    if (change.op === 'create') {
      const el = change.element;
      const encoded = this.#encode(el);
      const { rows } = await client.query(
        `INSERT INTO elements
           (project_id, layer_id, kind, srid, geom, z_values, params,
            geom_lod1, geom_lod2, geom_lod3, bbox, bbox_diag, metadata, version)
         VALUES ($1, $2, $3, $4,
                 ST_GeomFromEWKB(decode($5, 'hex')),
                 $6, $7,
                 ${lodExpr(8)}, ${lodExpr(9)}, ${lodExpr(10)},
                 Box2D(ST_GeomFromEWKB(decode($5, 'hex'))), $11, $12, 1)
         RETURNING id::text`,
        [
          projectId,
          el.layerId,
          kindToCode(el.kind),
          this.#srid,
          encoded.geomHex,
          encoded.zValues,
          el.params ?? null,
          encoded.lod1Hex,
          encoded.lod2Hex,
          encoded.lod3Hex,
          encoded.bboxDiag,
          el.metadata ?? null,
        ],
      );
      return {
        id: rows[0]!.id as string,
        version: 1,
        dirtyTiles: [...dirtyTilesForEdit(this.#scheme, null, encoded.bbox).tiles],
      };
    }

    // Update: read the previous footprint first so the old tiles are invalidated too, otherwise
    // a moved element leaves a ghost behind in the cache.
    const { rows: prevRows } = await client.query(
      `SELECT layer_id::text, kind, params, metadata, Box2D(geom)::text AS bbox_text,
              encode(ST_AsEWKB(geom), 'hex') AS geom_hex, z_values
         FROM elements WHERE id = $1::bigint`,
      [change.id],
    );
    const prev = prevRows[0];
    if (!prev) throw new Error(`Element ${change.id} vanished mid-commit`);
    const before = parseBox2d(prev.bbox_text as string);

    const merged: NewElement = {
      projectId,
      layerId: change.element.layerId ?? (prev.layer_id as string),
      kind: change.element.kind ?? codeToKind(prev.kind as number),
      crs: change.element.crs ?? String(this.#srid),
      coords: change.element.coords ?? decodeCoords(prev.geom_hex as string, prev.z_values as number[] | null),
      params: change.element.params ?? (prev.params as Record<string, number> | null) ?? undefined,
      metadata: change.element.metadata ?? (prev.metadata as Record<string, unknown> | null) ?? undefined,
    };
    const encoded = this.#encode(merged);

    const { rows } = await client.query(
      `UPDATE elements SET
          layer_id = $2, kind = $3,
          geom = ST_GeomFromEWKB(decode($4, 'hex')),
          z_values = $5, params = $6,
          geom_lod1 = ${lodExpr(7)}, geom_lod2 = ${lodExpr(8)}, geom_lod3 = ${lodExpr(9)},
          bbox = Box2D(ST_GeomFromEWKB(decode($4, 'hex'))), bbox_diag = $10,
          metadata = $11, version = version + 1, updated_at = now()
        WHERE id = $1::bigint
        RETURNING version`,
      [
        change.id,
        merged.layerId,
        kindToCode(merged.kind),
        encoded.geomHex,
        encoded.zValues,
        merged.params ?? null,
        encoded.lod1Hex,
        encoded.lod2Hex,
        encoded.lod3Hex,
        encoded.bboxDiag,
        merged.metadata ?? null,
      ],
    );

    return {
      id: change.id,
      version: rows[0]!.version as number,
      dirtyTiles: [...dirtyTilesForEdit(this.#scheme, before, encoded.bbox).tiles],
    };
  }

  #encode(el: NewElement) {
    const geom = toWkbGeometry(el.kind, el.coords, this.#srid);
    const lods = buildLodGeometries(el.kind, el.coords, this.#srid);
    const bbox = computeBBox(el.coords, el.params);
    const zValues = el.coords.every((c) => c.length >= 3) ? el.coords.map((c) => c[2]!) : null;

    return {
      geomHex: toHex(encodeEwkb(geom)),
      lod1Hex: lods.lod1 ? toHex(encodeEwkb(lods.lod1)) : null,
      lod2Hex: lods.lod2 ? toHex(encodeEwkb(lods.lod2)) : null,
      lod3Hex: lods.lod3 ? toHex(encodeEwkb(lods.lod3)) : null,
      zValues,
      bbox,
      bboxDiag: bboxDiagonal(bbox),
    };
  }

  async #markDirty(client: PoolClient, projectId: string, tiles: readonly TileCoord[]): Promise<void> {
    if (tiles.length === 0) return;
    // ON CONFLICT DO NOTHING: a tile already queued for rebuild does not need queuing twice.
    await client.query(
      `INSERT INTO dirty_tiles (project_id, z, x, y)
       SELECT $1, z, x, y FROM UNNEST($2::int[], $3::int[], $4::int[]) AS t(z, x, y)
       ON CONFLICT DO NOTHING`,
      [projectId, tiles.map((t) => t.z), tiles.map((t) => t.x), tiles.map((t) => t.y)],
    );
  }
}

/** NULL rather than an empty geometry when a LOD level collapses — see buildLodGeometries. */
function lodExpr(index: number): string {
  return `CASE WHEN $${index}::text IS NULL THEN NULL ELSE ST_GeomFromEWKB(decode($${index}, 'hex')) END`;
}

function decodeCoords(geomHex: string, zValues: number[] | null): number[][] {
  const geom = decodeEwkb(fromHex(geomHex));
  return geom.coordinates.map((c, i) => {
    const xy = [c[0]!, c[1]!];
    if (c.length >= 3) return [...xy, c[2]!];
    if (zValues && zValues[i] !== undefined) return [...xy, zValues[i]!];
    return xy;
  });
}

function parseBox2d(text: string | null): BBox | null {
  if (!text) return null;
  const m = /BOX\(([-\d.eE+]+) ([-\d.eE+]+),([-\d.eE+]+) ([-\d.eE+]+)\)/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function rowToRecord(row: Record<string, unknown>): ElementRecord {
  const coords = decodeCoords(row['geom_hex'] as string, (row['z_values'] as number[] | null) ?? null);
  const bbox = parseBox2d(row['bbox_text'] as string) ?? computeBBox(coords);
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    layerId: row['layer_id'] as string,
    kind: codeToKind(row['kind'] as number) as ElementKind,
    crs: `EPSG:${row['srid']}`,
    coords,
    params: (row['params'] as Record<string, number> | null) ?? undefined,
    metadata: undefined, // fetched lazily; never on the render path
    version: row['version'] as number,
    bbox,
  };
}
