// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import type { Coord3 } from '../types.ts';

/**
 * AutoCAD-style typed coordinate entry (architecture doc section 10).
 *
 * Typed input and mouse input must converge on one geometry-building code path, so this parser
 * produces the same kind of point the pointer produces — nothing downstream should be able to
 * tell which one the user used.
 *
 * Accepted forms (whitespace tolerant, comma or space separated):
 *   100,200          absolute 2D
 *   100,200,15       absolute 3D
 *   @10,5            relative to the last point
 *   @10,5,2          relative 3D
 *   @50<45           polar: 50 units at 45 degrees from the last point
 *   50<45            polar from the origin
 *
 * Axis order follows the active CRS: the two leading numbers are always the first two axis
 * labels of that CRS (X,Y or N,E or Lon,Lat), which is why this returns raw ordinates and
 * leaves labelling to the UI.
 */

export type ParsedInput =
  | { readonly mode: 'absolute'; readonly point: Coord3 }
  | { readonly mode: 'relative'; readonly delta: Coord3 }
  | { readonly mode: 'polar'; readonly distance: number; readonly angleDeg: number; readonly relative: boolean };

export class CoordinateInputError extends Error {}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;

function toNumber(raw: string, what: string): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new CoordinateInputError(`${what} is not a finite number: "${raw}"`);
  return v;
}

export function parseCoordinateInput(input: string): ParsedInput {
  const text = input.trim();
  if (text.length === 0) throw new CoordinateInputError('Empty coordinate input');

  const relative = text.startsWith('@');
  const body = relative ? text.slice(1).trim() : text;
  if (body.length === 0) throw new CoordinateInputError('Expected coordinates after "@"');

  // Polar: distance<angle
  const polar = new RegExp(String.raw`^(${NUM})\s*<\s*(${NUM})$`).exec(body);
  if (polar) {
    const distance = toNumber(polar[1]!, 'Distance');
    if (distance < 0) throw new CoordinateInputError(`Distance must not be negative: ${distance}`);
    return { mode: 'polar', distance, angleDeg: toNumber(polar[2]!, 'Angle'), relative };
  }

  if (body.includes('<')) {
    throw new CoordinateInputError(`Malformed polar input "${text}". Expected e.g. "@50<45".`);
  }

  const parts = body.split(/[,\s]+/).filter((p) => p.length > 0);
  if (parts.length < 2 || parts.length > 3) {
    throw new CoordinateInputError(
      `Expected 2 or 3 ordinates but got ${parts.length} in "${text}". Examples: "100,200", "100,200,15", "@10,5", "@50<45".`,
    );
  }

  const a = toNumber(parts[0]!, 'First ordinate');
  const b = toNumber(parts[1]!, 'Second ordinate');
  const c = parts.length === 3 ? toNumber(parts[2]!, 'Third ordinate') : 0;

  return relative ? { mode: 'relative', delta: [a, b, c] } : { mode: 'absolute', point: [a, b, c] };
}

/**
 * Resolves parsed input into an absolute point. `last` is the previous point of the geometry
 * being drawn, and is required for every relative form.
 */
export function resolveInput(parsed: ParsedInput, last: Coord3 | null): Coord3 {
  switch (parsed.mode) {
    case 'absolute':
      return parsed.point;
    case 'relative': {
      if (!last) throw new CoordinateInputError('Relative input needs a previous point');
      return [last[0] + parsed.delta[0], last[1] + parsed.delta[1], last[2] + parsed.delta[2]];
    }
    case 'polar': {
      const base: Coord3 = parsed.relative
        ? (last ?? (() => { throw new CoordinateInputError('Relative polar input needs a previous point'); })())
        : [0, 0, 0];
      const rad = (parsed.angleDeg * Math.PI) / 180;
      return [base[0] + parsed.distance * Math.cos(rad), base[1] + parsed.distance * Math.sin(rad), base[2]];
    }
  }
}

/** Formats a point for display using the active CRS axis labels. */
export function formatCoordinate(point: Coord3, axisLabels: readonly [string, string, string], decimals = 3): string {
  return `${axisLabels[0]} ${point[0].toFixed(decimals)}  ${axisLabels[1]} ${point[1].toFixed(decimals)}  ${axisLabels[2]} ${point[2].toFixed(decimals)}`;
}
