// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/** Core geometric types. All authoritative coordinates are float64 (P1). */

export type Coord2 = readonly [number, number];
export type Coord3 = readonly [number, number, number];
export type Coord = Coord2 | Coord3;

/** [minX, minY, maxX, maxY] */
export type BBox = readonly [number, number, number, number];

/** Axis labels follow the active CRS: X/Y/Z, N/E/H (Northing/Easting/Height), or Lon/Lat/H. */
export type AxisLabels = readonly [string, string, string];

export type CrsKind = 'geographic' | 'projected' | 'local';

/**
 * Parameters of a local / site engineering coordinate system (architecture doc section 3.2, 9).
 * Transform to the base CRS is: P_base = origin + R(rotation) * (scale * p_local)
 */
export interface LocalCrsParams {
  /** CRS code the local system is anchored to, e.g. 'EPSG:32635' */
  readonly baseCrs: string;
  /** Position of the local origin, expressed in baseCrs */
  readonly origin: Coord2;
  /** Rotation of the local axes, radians, counter-clockwise positive */
  readonly rotation: number;
  /** Uniform scale factor (site calibration); 1 = none */
  readonly scale: number;
  /** Height offset added to local h to obtain base H */
  readonly heightOffset: number;
}

export interface CrsDefinition {
  readonly code: string;
  readonly name: string;
  readonly kind: CrsKind;
  /** proj4 definition string. Required for geographic/projected, absent for local. */
  readonly proj4?: string;
  readonly axisLabels: AxisLabels;
  readonly units: 'm' | 'degree';
  /** Area of validity, in this CRS's own units. Used for render-origin choice and precision proofs. */
  readonly extent: BBox;
  readonly local?: LocalCrsParams;
}

export type ElementKind =
  | 'point'
  | 'line'
  | 'polyline'
  | 'polygon'
  | 'arc'
  | 'circle'
  | 'text'
  | 'insert';
