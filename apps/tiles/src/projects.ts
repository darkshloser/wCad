// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { Pool } from 'pg';
import type { BBox } from '@wcad/geo-core';
import { type TileScheme, createTileScheme } from '@wcad/tiling';

/**
 * Project registry.
 *
 * The tile scheme is derived from the project's stored extent rather than from environment
 * variables. That matters: client and server must agree on origin, resolutions and tile size
 * exactly, and a scheme configured in two places will eventually be configured differently. The
 * database row is the single source of truth, and `GET /projects` publishes it so the client
 * builds an identical grid instead of guessing.
 */

export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly crs: string;
  readonly srid: number;
  readonly extent: BBox;
  readonly elementCount: number;
}

const SCHEME_TTL_MS = 60_000;

export class ProjectRegistry {
  readonly #cache = new Map<string, { info: ProjectInfo; scheme: TileScheme; at: number }>();

  // Explicit fields, not constructor parameter properties: this service runs under
  // `node --experimental-strip-types`, which erases types without generating code, and a
  // parameter property requires a generated assignment.
  readonly #pool: Pool;
  readonly #fallbackExtent: BBox;
  readonly #maxZoom: number;

  constructor(pool: Pool, fallbackExtent: BBox, maxZoom = 24) {
    this.#pool = pool;
    this.#fallbackExtent = fallbackExtent;
    this.#maxZoom = maxZoom;
  }

  async list(): Promise<ProjectInfo[]> {
    const { rows } = await this.#pool.query(
      `SELECT p.id::text            AS id,
              p.name                AS name,
              p.crs_code            AS crs,
              Box2D(p.extent::geometry)::text AS extent_text,
              COALESCE(c.n, 0)::int AS element_count
         FROM projects p
         LEFT JOIN LATERAL (
           SELECT count(*) AS n FROM elements e
            WHERE e.project_id = p.id AND e.deleted_at IS NULL
         ) c ON true
        ORDER BY p.id DESC`,
    );
    return rows.map((r) => this.#toInfo(r));
  }

  async get(projectId: string): Promise<{ info: ProjectInfo; scheme: TileScheme } | null> {
    const cached = this.#cache.get(projectId);
    if (cached && Date.now() - cached.at < SCHEME_TTL_MS) return cached;

    const { rows } = await this.#pool.query(
      `SELECT p.id::text            AS id,
              p.name                AS name,
              p.crs_code            AS crs,
              Box2D(p.extent::geometry)::text AS extent_text,
              COALESCE(c.n, 0)::int AS element_count
         FROM projects p
         LEFT JOIN LATERAL (
           SELECT count(*) AS n FROM elements e
            WHERE e.project_id = p.id AND e.deleted_at IS NULL
         ) c ON true
        WHERE p.id = $1::bigint`,
      [projectId],
    );
    if (rows.length === 0) return null;

    const info = this.#toInfo(rows[0] as Record<string, unknown>);
    const scheme = createTileScheme(info.crs, info.extent, { maxZoom: this.#maxZoom });
    const entry = { info, scheme, at: Date.now() };
    this.#cache.set(projectId, entry);
    return entry;
  }

  /** Dropped after a bulk load so a freshly seeded extent is picked up immediately. */
  invalidate(projectId?: string): void {
    if (projectId) this.#cache.delete(projectId);
    else this.#cache.clear();
  }

  #toInfo(row: Record<string, unknown>): ProjectInfo {
    const crs = (row['crs'] as string) ?? 'EPSG:32635';
    // A project with no geometry yet has a NULL extent; fall back so the pyramid is still valid
    // and the map still renders rather than failing on an empty project.
    const extent = parseBox2d(row['extent_text'] as string | null) ?? this.#fallbackExtent;
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      crs,
      srid: sridFromCrs(crs),
      extent,
      elementCount: (row['element_count'] as number) ?? 0,
    };
  }
}

export function sridFromCrs(crs: string): number {
  const m = /^EPSG:(\d+)$/i.exec(crs.trim());
  if (!m) throw new Error(`Cannot derive an SRID from CRS code "${crs}"`);
  return Number(m[1]);
}

export function parseBox2d(text: string | null): BBox | null {
  if (!text) return null;
  const m = /BOX\(([-\d.eE+]+) ([-\d.eE+]+),([-\d.eE+]+) ([-\d.eE+]+)\)/.exec(text);
  if (!m) return null;
  const bbox: BBox = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  // A single-point project has a zero-area extent, which cannot anchor a tile pyramid.
  if (bbox[2] - bbox[0] <= 0 || bbox[3] - bbox[1] <= 0) {
    const pad = 1;
    return [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
  }
  return bbox;
}
