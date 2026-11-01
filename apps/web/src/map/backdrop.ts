// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import VectorTileLayer from 'ol/layer/VectorTile';
import VectorTileSource from 'ol/source/VectorTile';
import MVT from 'ol/format/MVT';
import TileGrid from 'ol/tilegrid/TileGrid';
import { Fill, Stroke, Style } from 'ol/style';
import CircleStyle from 'ol/style/Circle';
import type { TileScheme } from '@wcad/tiling';
import { resolution, tileCount } from '@wcad/tiling';

/**
 * The backdrop layer (architecture doc sections 3 and 5).
 *
 * This is where the millions of objects live. It is read-only by construction: MVT features
 * carry quantized tile coordinates, never authoritative geometry, so there is nothing here for
 * editing code to consume even by accident (principle P1). Anything the user interacts with is
 * promoted into the working-set layer through the exact-geometry API first.
 *
 * `renderMode: 'hybrid'` rasterizes lines and polygons while keeping text and symbols as
 * vectors. Full vector mode is more accurate but measurably slower, and OpenLayers' WebGL vector
 * tile renderer is not yet a clear win over canvas — so the backdrop uses canvas hybrid and the
 * working set uses WebGL.
 */

export interface BackdropOptions {
  readonly scheme: TileScheme;
  readonly projectId: string;
  readonly tileServiceUrl: string;
  readonly layerIds?: readonly string[];
  onTileLoad?(ms: number): void;
  onTileError?(url: string): void;
}

/**
 * Tile grid in the PROJECT'S CRS, matching the server-side scheme exactly.
 *
 * Both sides must agree on origin, resolutions and tile size or the client requests tiles that
 * do not exist and renders the ones it gets in the wrong place — a failure that looks like a
 * projection bug and is not one.
 */
export function createTileGrid(scheme: TileScheme): TileGrid {
  const resolutions: number[] = [];
  const sizes: Array<[number, number]> = [];
  for (let z = 0; z <= scheme.maxZoom; z++) {
    resolutions.push(resolution(scheme, z));
    sizes.push([tileCount(z), tileCount(z)]);
  }

  return new TileGrid({
    // OpenLayers expects the top-left corner, which is how TileScheme defines its origin.
    origin: [scheme.origin[0], scheme.origin[1]],
    resolutions,
    tileSize: scheme.tilePixels,
    sizes,
  });
}

export function createBackdropLayer(opts: BackdropOptions): VectorTileLayer {
  const layerQuery = opts.layerIds?.length ? `?layers=${opts.layerIds.join(',')}` : '';

  const source = new VectorTileSource({
    format: new MVT(),
    projection: opts.scheme.crs,
    tileGrid: createTileGrid(opts.scheme),
    url: `${opts.tileServiceUrl}/tiles/${opts.projectId}/{z}/{x}/{y}.mvt${layerQuery}`,
    // The backdrop is a cache-friendly read path; letting OpenLayers retry aggressively just
    // multiplies load during a pan.
    cacheSize: 512,
  });

  if (opts.onTileLoad || opts.onTileError) {
    const started = new WeakMap<object, number>();
    source.on('tileloadstart', (e) => started.set(e.tile, performance.now()));
    source.on('tileloadend', (e) => {
      const t0 = started.get(e.tile);
      if (t0 !== undefined) opts.onTileLoad?.(performance.now() - t0);
    });
    source.on('tileloaderror', () => opts.onTileError?.(source.getUrls()?.[0] ?? 'unknown'));
  }

  return new VectorTileLayer({
    source,
    renderMode: 'hybrid',
    declutter: false,
    style: backdropStyle,
    // Drawn beneath the working set so edited geometry is always visually on top.
    zIndex: 0,
  });
}

const BACKDROP_STROKE = new Stroke({ color: 'rgba(120, 150, 190, 0.75)', width: 1 });
const BACKDROP_FILL = new Fill({ color: 'rgba(90, 120, 160, 0.10)' });

const styleCache = new Map<string, Style>();

/**
 * Styling reads a numeric style id carried in the tile rather than a per-element style object.
 * A million elements share a few hundred styles, so shipping style JSON per feature would
 * dominate tile size for no benefit.
 */
function backdropStyle(feature: { get(key: string): unknown }): Style {
  const key = String(feature.get('style_id') ?? 'default');
  let style = styleCache.get(key);
  if (!style) {
    style = new Style({
      stroke: BACKDROP_STROKE,
      fill: BACKDROP_FILL,
      image: new CircleStyle({ radius: 2, fill: new Fill({ color: 'rgba(120, 150, 190, 0.9)' }) }),
    });
    styleCache.set(key, style);
  }
  return style;
}
