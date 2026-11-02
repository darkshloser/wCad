// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import TileGrid from 'ol/tilegrid/TileGrid';
import type { TileScheme } from '@wcad/tiling';
import { pyramidExtent, resolution, tileCount } from '@wcad/tiling';

/**
 * Tile grid in the PROJECT'S CRS, matching the server-side scheme exactly.
 *
 * Both sides must agree on origin, resolutions and tile size or the client requests tiles that
 * do not exist and renders the ones it gets in the wrong place — a failure that looks like a
 * projection bug and is not one.
 *
 * The `extent` is not optional, even though `sizes` looks like it already bounds the grid.
 * OpenLayers' vector tile source builds its own rendering grid from the source grid's EXTENT, and
 * works out which source tiles to fetch by intersecting with that extent. With no extent, every
 * view reaching past the project edge — zooming out always does — requested tiles outside the
 * pyramid. Each came back as an error, and any rendered tile containing a failed piece was left
 * blank, so the drawing vanished. `sizes` alone did not prevent it.
 */
export function createTileGrid(scheme: TileScheme): TileGrid {
  const resolutions: number[] = [];
  const sizes: Array<[number, number]> = [];
  for (let z = 0; z <= scheme.maxZoom; z++) {
    resolutions.push(resolution(scheme, z));
    sizes.push([tileCount(z), tileCount(z)]);
  }

  return new TileGrid({
    extent: [...pyramidExtent(scheme)],
    // OpenLayers expects the top-left corner, which is how TileScheme defines its origin.
    origin: [scheme.origin[0], scheme.origin[1]],
    resolutions,
    tileSize: scheme.tilePixels,
    sizes,
  });
}
