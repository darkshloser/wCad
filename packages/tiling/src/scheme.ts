// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { BBox, Coord2 } from '@wcad/geo-core';

/**
 * Tile scheme, defined in the PROJECT'S OWN CRS.
 *
 * Web mapping normally tiles in Web Mercator, and doing that here would be a mistake: project
 * data lives in a projected or local engineering CRS and is never implicitly reprojected at
 * rest (architecture doc section 9). Reprojecting 10M objects into Web Mercator just to tile
 * them would be both slow and lossy, and would put a datum transformation between the user and
 * their own survey coordinates.
 *
 * Nothing in the MVT specification requires Web Mercator — a tile is just a quantized grid cell.
 * So the pyramid is anchored on the project extent instead, which keeps every tile boundary at
 * an exact power-of-two subdivision of coordinates the surveyor recognizes.
 *
 * Axis convention: the origin is the TOP-LEFT corner (minX, maxY). Tile x increases eastward and
 * tile y increases southward, matching the usual XYZ convention, while the underlying CRS keeps
 * Y increasing northward.
 */
export interface TileScheme {
  readonly crs: string;
  /** Top-left corner of tile (0, 0) at zoom 0, in CRS units. */
  readonly origin: Coord2;
  /** Side length in CRS units of one tile at zoom 0. Square by construction. */
  readonly z0Size: number;
  /** Nominal on-screen tile size in pixels; drives the resolution ladder. */
  readonly tilePixels: number;
  readonly maxZoom: number;
}

export interface TileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface TileSchemeOptions {
  readonly tilePixels?: number;
  readonly maxZoom?: number;
  /** Extra margin around the extent, as a fraction of its larger side. */
  readonly padding?: number;
}

/**
 * Builds a square scheme that fully contains `extent`.
 *
 * The z0 tile is square and padded so that geometry exactly on the extent boundary still falls
 * inside the pyramid — an element sitting precisely on the edge is common in cadastral data.
 */
export function createTileScheme(crs: string, extent: BBox, opts: TileSchemeOptions = {}): TileScheme {
  const width = extent[2] - extent[0];
  const height = extent[3] - extent[1];
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`Tile scheme needs a positive extent, got [${extent.join(', ')}]`);
  }
  const padding = opts.padding ?? 0.05;
  const side = Math.max(width, height) * (1 + padding);
  const cx = (extent[0] + extent[2]) / 2;
  const cy = (extent[1] + extent[3]) / 2;

  return {
    crs,
    origin: [cx - side / 2, cy + side / 2],
    z0Size: side,
    tilePixels: opts.tilePixels ?? 512,
    maxZoom: opts.maxZoom ?? 24,
  };
}

/** Side length of a tile at zoom `z`, in CRS units. */
export function tileSize(scheme: TileScheme, z: number): number {
  assertZoom(scheme, z);
  return scheme.z0Size / 2 ** z;
}

/** CRS units per screen pixel at zoom `z`. */
export function resolution(scheme: TileScheme, z: number): number {
  return tileSize(scheme, z) / scheme.tilePixels;
}

/** Lowest zoom whose resolution is at least as fine as `target`. */
export function zoomForResolution(scheme: TileScheme, target: number): number {
  if (!(target > 0)) throw new Error(`Resolution must be positive, got ${target}`);
  const z = Math.ceil(Math.log2(scheme.z0Size / (scheme.tilePixels * target)));
  return Math.min(scheme.maxZoom, Math.max(0, z));
}

export function tileCount(z: number): number {
  return 2 ** z;
}

/**
 * Extent of a tile in CRS coordinates.
 *
 * Tiles are half-open in both axes — [minX, maxX) and (minY, maxY] — so a coordinate on a shared
 * boundary belongs to exactly one tile. Without that, boundary vertices are emitted twice and
 * the "no gaps, no duplicates" invariant fails in a way that only shows up on real data.
 */
export function tileBBox(scheme: TileScheme, tile: TileCoord): BBox {
  assertTile(scheme, tile);
  const size = tileSize(scheme, tile.z);
  const minX = scheme.origin[0] + tile.x * size;
  const maxY = scheme.origin[1] - tile.y * size;
  return [minX, maxY - size, minX + size, maxY];
}

/**
 * The area the pyramid covers: the zoom-0 tile, in CRS coordinates.
 *
 * Clients must bound their tile grid by exactly this. A grid without an extent lets the client
 * request tiles beyond the pyramid whenever the view reaches past the project's edge — zooming
 * out far enough always does — and every one of those requests is for a tile that cannot exist.
 */
export function pyramidExtent(scheme: TileScheme): BBox {
  return [scheme.origin[0], scheme.origin[1] - scheme.z0Size, scheme.origin[0] + scheme.z0Size, scheme.origin[1]];
}

/** True when the tile exists in the pyramid. Unlike tileBBox, never throws. */
export function isInPyramid(scheme: TileScheme, tile: TileCoord): boolean {
  if (!Number.isInteger(tile.z) || tile.z < 0 || tile.z > scheme.maxZoom) return false;
  const n = tileCount(tile.z);
  return Number.isInteger(tile.x) && Number.isInteger(tile.y) && tile.x >= 0 && tile.y >= 0 && tile.x < n && tile.y < n;
}

/** Tile containing a point at zoom `z`, or null when the point is outside the pyramid. */
export function tileContaining(scheme: TileScheme, z: number, point: Coord2): TileCoord | null {
  assertZoom(scheme, z);
  const size = tileSize(scheme, z);
  const n = tileCount(z);
  const fx = (point[0] - scheme.origin[0]) / size;
  const fy = (scheme.origin[1] - point[1]) / size;
  if (fx < 0 || fy < 0 || fx > n || fy > n) return null;
  // Clamp the far edge inward so the closing boundary belongs to the last tile.
  const x = Math.min(n - 1, Math.floor(fx));
  const y = Math.min(n - 1, Math.floor(fy));
  return { z, x, y };
}

/** Every tile at zoom `z` intersecting `bbox`, in deterministic row-major order. */
export function tilesForBBox(scheme: TileScheme, z: number, bbox: BBox): TileCoord[] {
  assertZoom(scheme, z);
  const size = tileSize(scheme, z);
  const n = tileCount(z);

  const x0 = Math.max(0, Math.floor((bbox[0] - scheme.origin[0]) / size));
  const x1 = Math.min(n - 1, Math.floor((bbox[2] - scheme.origin[0]) / size));
  const y0 = Math.max(0, Math.floor((scheme.origin[1] - bbox[3]) / size));
  const y1 = Math.min(n - 1, Math.floor((scheme.origin[1] - bbox[1]) / size));

  const out: TileCoord[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) out.push({ z, x, y });
  }
  return out;
}

/** Parent tile one zoom level up, or null at zoom 0. */
export function parentTile(tile: TileCoord): TileCoord | null {
  if (tile.z === 0) return null;
  return { z: tile.z - 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) };
}

export function childTiles(tile: TileCoord): TileCoord[] {
  const z = tile.z + 1;
  const x = tile.x * 2;
  const y = tile.y * 2;
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ];
}

/** Stable cache key. Layer sets are sorted so key generation is order-independent. */
export function tileKey(projectId: string, tile: TileCoord, layerIds?: readonly string[]): string {
  const base = `${projectId}/${tile.z}/${tile.x}/${tile.y}`;
  if (!layerIds || layerIds.length === 0) return base;
  return `${base}?l=${[...layerIds].sort().join(',')}`;
}

function assertZoom(scheme: TileScheme, z: number): void {
  if (!Number.isInteger(z) || z < 0 || z > scheme.maxZoom) {
    throw new Error(`Zoom must be an integer in [0, ${scheme.maxZoom}], got ${z}`);
  }
}

function assertTile(scheme: TileScheme, tile: TileCoord): void {
  assertZoom(scheme, tile.z);
  const n = tileCount(tile.z);
  if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 || tile.y < 0 || tile.x >= n || tile.y >= n) {
    throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} is outside the pyramid (0..${n - 1})`);
  }
}
