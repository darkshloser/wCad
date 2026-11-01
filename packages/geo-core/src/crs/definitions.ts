// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { CrsDefinition } from '../types.ts';

/**
 * Built-in CRS presets.
 *
 * IMPORTANT: proj4 strings below are taken from public EPSG registry entries. Before production
 * use, each one must be verified against epsg.io / the official national geodetic authority and
 * covered by a fixture in `crs-points.json` with independently known-correct coordinates.
 * A wrong proj4 string produces plausible-looking but systematically shifted data, which is the
 * single most damaging class of bug in this system (see IMPLEMENTATION-PLAN.md section 15).
 *
 * AXIS ORDER: internally, coordinates are always stored and passed as (x, y) = (easting,
 * northing) — the order proj4 emits — regardless of what the EPSG registry declares as the
 * official axis order. `axisLabels` affects the UI readout and typed coordinate entry only.
 * Mixing these two conventions is a classic source of transposed-coordinate bugs, so the rule
 * is deliberately blunt: storage is always x=east, y=north; presentation follows axisLabels.
 */
export const BUILTIN_CRS: readonly CrsDefinition[] = [
  {
    code: 'EPSG:4326',
    name: 'WGS 84 (geographic)',
    kind: 'geographic',
    proj4: '+proj=longlat +datum=WGS84 +no_defs',
    axisLabels: ['Lon', 'Lat', 'H'],
    units: 'degree',
    extent: [-180, -90, 180, 90],
  },
  {
    code: 'EPSG:3857',
    name: 'WGS 84 / Pseudo-Mercator',
    kind: 'projected',
    proj4:
      '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
    axisLabels: ['X', 'Y', 'Z'],
    units: 'm',
    extent: [-20037508.34, -20048966.1, 20037508.34, 20048966.1],
  },
  {
    code: 'EPSG:32635',
    name: 'WGS 84 / UTM zone 35N',
    kind: 'projected',
    proj4: '+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs',
    axisLabels: ['E', 'N', 'H'],
    units: 'm',
    extent: [166021, 0, 833978, 9329005],
  },
  {
    code: 'EPSG:7801',
    name: 'BGS2005 / CCS2005 (Bulgaria)',
    kind: 'projected',
    proj4:
      '+proj=lcc +lat_0=42.6678756833333 +lon_0=25.5 +lat_1=42 +lat_2=43.3333333333333 ' +
      '+x_0=500000 +y_0=4725824.3591 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    axisLabels: ['N', 'E', 'H'],
    units: 'm',
    // In proj4 output order (x = easting, y = northing), covering Bulgaria.
    extent: [250000, 4590000, 750000, 4770000],
  },
  {
    code: 'EPSG:27700',
    name: 'OSGB36 / British National Grid',
    kind: 'projected',
    proj4:
      '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy ' +
      '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
    axisLabels: ['E', 'N', 'H'],
    units: 'm',
    extent: [0, 0, 700000, 1300000],
  },
];
