// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { LOD_TOLERANCES, simplify } from '@wcad/geo-core';
import type { BBox, Coord2, ElementKind } from '@wcad/geo-core';
import type { WkbGeometry, WkbGeometryType } from './wkb.ts';

/**
 * Mapping between wCAD element records and PostGIS geometry.
 *
 * The LOD columns are generalized HERE, in application code, using geo-core's `simplify`, rather
 * than with PostGIS's ST_Simplify. Both are Douglas-Peucker, but their endpoint and tolerance
 * handling differ in small ways, and the client renders the working set from the same geo-core
 * code. Generalizing in one shared implementation makes client and server agree by construction
 * instead of by coincidence — the alternative is a backdrop that visibly disagrees with the
 * geometry the user is editing.
 */

/** Which PostGIS geometry type stores each CAD element kind. */
export function wkbTypeForKind(kind: ElementKind, vertexCount: number): WkbGeometryType {
  switch (kind) {
    case 'point':
    case 'text':
    case 'insert':
      return 'Point';
    case 'polygon':
      return 'Polygon';
    case 'circle':
    case 'arc':
      // Stored as their tessellated display path; the canonical definition lives in `params`
      // and is what everything precision-sensitive actually reads (principle P1).
      return 'LineString';
    case 'line':
    case 'polyline':
      return vertexCount < 2 ? 'Point' : 'LineString';
  }
}

export function toWkbGeometry(
  kind: ElementKind,
  coords: ReadonlyArray<readonly number[]>,
  srid: number,
): WkbGeometry {
  if (coords.length === 0) throw new Error(`Element of kind ${kind} has no coordinates`);
  const type = wkbTypeForKind(kind, coords.length);
  const hasZ = coords.every((c) => c.length >= 3);

  if (type === 'Point') {
    return { type, srid, hasZ, coordinates: [coords[0]!] };
  }
  if (type === 'Polygon') {
    return { type, srid, hasZ, coordinates: closeRing(coords) };
  }
  return { type, srid, hasZ, coordinates: coords };
}

/** PostGIS requires polygon rings to be explicitly closed; CAD polygons usually are not. */
export function closeRing(coords: ReadonlyArray<readonly number[]>): number[][] {
  const ring = coords.map((c) => [...c]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
  while (ring.length < 4) ring.push([...first]);
  return ring;
}

export function computeBBox(coords: ReadonlyArray<readonly number[]>, params?: Readonly<Record<string, number>>): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of coords) {
    if (c[0]! < minX) minX = c[0]!;
    if (c[1]! < minY) minY = c[1]!;
    if (c[0]! > maxX) maxX = c[0]!;
    if (c[1]! > maxY) maxY = c[1]!;
  }
  if (params && typeof params['cx'] === 'number' && typeof params['cy'] === 'number' && typeof params['r'] === 'number') {
    minX = Math.min(minX, params['cx'] - params['r']);
    minY = Math.min(minY, params['cy'] - params['r']);
    maxX = Math.max(maxX, params['cx'] + params['r']);
    maxY = Math.max(maxY, params['cy'] + params['r']);
  }
  if (!Number.isFinite(minX)) throw new Error('Cannot compute a bounding box without coordinates');
  return [minX, minY, maxX, maxY];
}

export function bboxDiagonal(bbox: BBox): number {
  return Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]);
}

export interface LodGeometries {
  readonly lod1: WkbGeometry | null;
  readonly lod2: WkbGeometry | null;
  readonly lod3: WkbGeometry | null;
}

/**
 * Builds the generalized display copies.
 *
 * A level is null when generalization collapses the geometry below what the type needs — a
 * building outline simplified at 100 m tolerance is not a polygon any more. Null means "nothing
 * to draw at this zoom", which is exactly right: the element is smaller than a pixel there.
 */
export function buildLodGeometries(
  kind: ElementKind,
  coords: ReadonlyArray<readonly number[]>,
  srid: number,
): LodGeometries {
  const type = wkbTypeForKind(kind, coords.length);

  // Points are already minimal; generalization is a no-op and must not drop them.
  if (type === 'Point') {
    const g = toWkbGeometry(kind, coords, srid);
    return { lod1: g, lod2: g, lod3: g };
  }

  const xy: Coord2[] = coords.map((c) => [c[0]!, c[1]!]);
  const levels = LOD_TOLERANCES.map((tolerance) => {
    const simplified = simplify(xy, tolerance);
    const minVertices = type === 'Polygon' ? 3 : 2;
    if (simplified.length < minVertices) return null;
    return toWkbGeometry(kind, simplified, srid);
  });

  return { lod1: levels[0] ?? null, lod2: levels[1] ?? null, lod3: levels[2] ?? null };
}
