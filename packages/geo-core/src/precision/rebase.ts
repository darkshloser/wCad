// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { BBox, Coord2 } from '../types.ts';

/**
 * Float32 safety for the GPU path (architecture doc section 5.2).
 *
 * GPUs work in 32-bit floats (24-bit mantissa, ~7 significant decimal digits). A projected
 * northing such as 4650321.104 cannot be represented in float32 without losing centimetre
 * detail, which shows up as vertex jitter when zoomed in. Every coordinate uploaded to the GPU
 * is therefore rebased against a project render origin in float64 first.
 *
 * The authoritative store always keeps absolute float64 values. Rebasing is display-only.
 */

/** Smallest representable increment of a float32 near `magnitude`. */
export function float32Resolution(magnitude: number): number {
  const m = Math.abs(magnitude);
  if (m === 0) return 2 ** -149; // smallest subnormal
  const exponent = Math.floor(Math.log2(m));
  return 2 ** (exponent - 23);
}

/**
 * Picks a render origin for an extent. Rounded to a whole unit so the value is stable and
 * human-readable in debugging, and so small view changes do not churn the origin.
 */
export function chooseRenderOrigin(extent: BBox): Coord2 {
  const cx = (extent[0] + extent[2]) / 2;
  const cy = (extent[1] + extent[3]) / 2;
  return [Math.round(cx), Math.round(cy)];
}

/** Worst-case float32 resolution for an extent rendered relative to `origin`. */
export function worstCaseResolution(extent: BBox, origin: Coord2): number {
  const maxDx = Math.max(Math.abs(extent[0] - origin[0]), Math.abs(extent[2] - origin[0]));
  const maxDy = Math.max(Math.abs(extent[1] - origin[1]), Math.abs(extent[3] - origin[1]));
  return float32Resolution(Math.max(maxDx, maxDy));
}

/**
 * Throws if rendering `extent` relative to `origin` cannot resolve `required` units.
 * Called when a project is opened, so a precision problem surfaces immediately rather than
 * as inexplicable jitter later.
 */
export function assertRenderPrecision(extent: BBox, origin: Coord2, required: number): void {
  const actual = worstCaseResolution(extent, origin);
  if (actual > required) {
    throw new Error(
      `Render origin [${origin[0]}, ${origin[1]}] gives float32 resolution of ${actual} ` +
        `over the project extent, which is coarser than the required ${required}. ` +
        `Choose an origin closer to the data, or split the project.`,
    );
  }
}

/** Rebase float64 coordinates into a packed float32 buffer for GPU upload. */
export function rebaseToFloat32(coords: readonly Coord2[], origin: Coord2): Float32Array {
  const out = new Float32Array(coords.length * 2);
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i]!;
    out[i * 2] = c[0] - origin[0];
    out[i * 2 + 1] = c[1] - origin[1];
  }
  return out;
}

/**
 * Inverse of rebaseToFloat32. Lossy by construction — for display round-tripping and tests only.
 * Never feed the result back into the authoritative store.
 */
export function unrebaseFromFloat32(buf: Float32Array, origin: Coord2): Coord2[] {
  const out: Coord2[] = [];
  for (let i = 0; i < buf.length; i += 2) {
    out.push([buf[i]! + origin[0], buf[i + 1]! + origin[1]]);
  }
  return out;
}
