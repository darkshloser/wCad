// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Regression: "25 tile errors" and the drawing vanishing after zooming out.
 *
 * The tile service logged requests such as 0/1/0 and 0/2/1 — tiles that cannot exist, because
 * zoom 0 has exactly one tile. They came from OpenLayers itself: its vector tile source decides
 * which tiles to fetch by intersecting the view with the tile grid's extent, and our grid had
 * none. This test drives that same OpenLayers code path rather than re-deriving the arithmetic, so
 * it fails for the reason the browser failed.
 */

import { describe, expect, it } from 'vitest';
import VectorTileSource from 'ol/source/VectorTile';
import MVT from 'ol/format/MVT';
import TileGrid from 'ol/tilegrid/TileGrid';
import Projection from 'ol/proj/Projection';
import { addProjection } from 'ol/proj';
import { buffer } from 'ol/extent';
import { createTileScheme, isInPyramid, pyramidExtent, resolution, tileCount } from '@wcad/tiling';
import { createTileGrid } from '../src/map/tileGrid.ts';

const CODE = 'TEST:TILEGRID';
const projection = new Projection({ code: CODE, units: 'm', extent: [-1e7, -1e7, 1e7, 1e7] });
addProjection(projection);

const scheme = { ...createTileScheme(CODE, [500000, 4700000, 501000, 4700500]), maxZoom: 4 };
const URL_TEMPLATE = 'http://tiles.test/tiles/p/{z}/{x}/{y}.mvt';

/** Every source-tile URL OpenLayers would fetch for a view far larger than the project. */
function requestedTiles(grid: TileGrid): Array<{ z: number; x: number; y: number }> {
  const source = new VectorTileSource({
    format: new MVT(),
    projection: CODE,
    tileGrid: grid,
    url: URL_TEMPLATE,
    tileLoadFunction: () => {}, // never fetch; we only want the URLs
  });
  // Zoomed far out: the view is five times the size of the whole pyramid.
  const view = buffer([...pyramidExtent(scheme)], scheme.z0Size * 2);
  const renderGrid = source.getTileGridForProjection(projection);

  const out: Array<{ z: number; x: number; y: number }> = [];
  for (let z = 0; z <= scheme.maxZoom; z++) {
    renderGrid.forEachTileCoord(view, z, ([tz, x, y]) => {
      const tile = source.getTile(tz, x, y, 1, projection);
      // Same call OpenLayers makes when a render tile loads.
      (source as unknown as { getSourceTiles: (r: number, p: Projection, t: unknown) => void }).getSourceTiles(
        1,
        projection,
        tile,
      );
      for (const st of (tile as unknown as { sourceTiles: Array<{ tileCoord: number[] }> }).sourceTiles) {
        const [sz, sx, sy] = st.tileCoord;
        out.push({ z: sz!, x: sx!, y: sy! });
      }
    });
  }
  return out;
}

describe('backdrop tile grid', () => {
  it('is bounded by exactly the pyramid', () => {
    expect(createTileGrid(scheme).getExtent()).toEqual(pyramidExtent(scheme));
  });

  it('never requests a tile outside the pyramid, however far the view is zoomed out', () => {
    const tiles = requestedTiles(createTileGrid(scheme));
    expect(tiles.length).toBeGreaterThan(0);
    const outside = tiles.filter((t) => !isInPyramid(scheme, t));
    expect(outside.map((t) => `${t.z}/${t.x}/${t.y}`)).toEqual([]);
  });

  it('control: the previous grid (sizes but no extent) does request tiles outside the pyramid', () => {
    // Without this, a passing test above could mean the harness never exercised the bug.
    const resolutions = [];
    const sizes: Array<[number, number]> = [];
    for (let z = 0; z <= scheme.maxZoom; z++) {
      resolutions.push(resolution(scheme, z));
      sizes.push([tileCount(z), tileCount(z)]);
    }
    const oldGrid = new TileGrid({ origin: [...scheme.origin], resolutions, tileSize: scheme.tilePixels, sizes });
    const outside = requestedTiles(oldGrid).filter((t) => !isInPyramid(scheme, t));
    expect(outside.length).toBeGreaterThan(0);
  });
});
