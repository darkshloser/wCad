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
import type VectorTile from 'ol/VectorTile';
import type { FeatureLike } from 'ol/Feature';
import { Fill, Stroke, Style } from 'ol/style';
import CircleStyle from 'ol/style/Circle';
import type { TileScheme } from '@wcad/tiling';
import { createTileGrid } from './tileGrid.ts';

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
  onTileError?(error: TileError): void;
}

/** Why a tile failed: enough to diagnose it without opening DevTools. */
export interface TileError {
  readonly url: string;
  /** HTTP status, or 0 when the request never got a response (service down, network). */
  readonly status: number;
  readonly message: string;
}

export { createTileGrid };

export function createBackdropLayer(opts: BackdropOptions): VectorTileLayer {
  const layerQuery = opts.layerIds?.length ? `?layers=${opts.layerIds.join(',')}` : '';
  const format = new MVT();

  const source = new VectorTileSource({
    format,
    projection: opts.scheme.crs,
    tileGrid: createTileGrid(opts.scheme),
    url: `${opts.tileServiceUrl}/tiles/${opts.projectId}/{z}/{x}/{y}.mvt${layerQuery}`,
    // The backdrop is a cache-friendly read path; letting OpenLayers retry aggressively just
    // multiplies load during a pan.
    cacheSize: 512,
    // Own loader rather than OpenLayers' default, for one reason: the default reports a failed
    // tile with no URL, status or server message, which left "25 tile errors" in the status bar
    // and nothing to diagnose it with. Decoding is unchanged — the same MVT format, same options.
    tileLoadFunction: (tile, url) => {
      const vt = tile as VectorTile<FeatureLike>;
      // Not an async function: OpenLayers ignores the loader's return value, and its type wants
      // void. The work runs in a promise the loader starts.
      vt.setLoader((extent, _resolution, projection) => void (async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            opts.onTileError?.({ url, status: res.status, message: await errorMessage(res) });
            vt.onError();
            return;
          }
          const data = await res.arrayBuffer();
          vt.setFeatures(format.readFeatures(data, { extent, featureProjection: projection }) as FeatureLike[]);
        } catch (err) {
          opts.onTileError?.({ url, status: 0, message: (err as Error).message || 'request failed' });
          vt.onError();
        }
      })());
    },
  });

  if (opts.onTileLoad) {
    const started = new WeakMap<object, number>();
    source.on('tileloadstart', (e) => started.set(e.tile, performance.now()));
    source.on('tileloadend', (e) => {
      const t0 = started.get(e.tile);
      if (t0 !== undefined) opts.onTileLoad?.(performance.now() - t0);
    });
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

/** The tile service answers errors as JSON { error, detail }; fall back to the raw text. */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: string; detail?: string };
    return [body.error, body.detail].filter(Boolean).join(': ') || res.statusText;
  } catch {
    return text.slice(0, 200) || res.statusText;
  }
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
