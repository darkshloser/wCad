// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Rules for the in-progress drawing style (knowledge/drawing-style-spec.md), free of OpenLayers.
 *
 * OpenLayers hands the drawing style one geometry per sketch: a polyline as one line whose LAST
 * vertex is the moving cursor, a polygon as a ring ending in "…, cursor, first vertex". The spec
 * styles the placed part, the rubber band and the closing edge differently, so these functions
 * split those geometries into the parts the spec names.
 */

export type Background = 'dark' | 'light';
type XY = readonly number[];

export interface SketchColours {
  /** Lines, vertex outlines and the cursor. */
  readonly stroke: string;
  /** Inside of a placed-vertex square: the background, so the square reads as hollow. */
  readonly vertexFill: string;
  /** Polygon fill: the stroke colour at 8 % opacity. */
  readonly fill: string;
}

/** Spec §2. Never a colour used by finished, hover, selected or snap states. */
export function sketchColours(bg: Background): SketchColours {
  return bg === 'light'
    ? { stroke: '#374151', vertexFill: '#f4f6f8', fill: 'rgba(55, 65, 81, 0.08)' }
    : { stroke: '#e5e7eb', vertexFill: '#0b0f14', fill: 'rgba(229, 231, 235, 0.08)' };
}

/** Colours the other states use; the in-progress colour must differ from all of them. */
export const OTHER_STATE_COLOURS = ['#2b6cb0', '#3b82f6', '#e8590c', '#22c55e'] as const;

export interface OpenSketchParts {
  /** Vertices already clicked (everything but the cursor). */
  readonly placed: XY[];
  /** Last placed vertex → cursor; null before the first click. */
  readonly rubber: [XY, XY] | null;
}

/** A polyline sketch: coordinates are the placed vertices followed by the cursor. */
export function splitOpenSketch(coords: readonly XY[]): OpenSketchParts {
  if (coords.length < 2) return { placed: [...coords], rubber: null };
  return {
    placed: coords.slice(0, -1),
    rubber: [coords[coords.length - 2]!, coords[coords.length - 1]!],
  };
}

export interface PolygonSketchParts extends OpenSketchParts {
  /** Cursor → first vertex, once two vertices are placed (spec §3); null before that. */
  readonly closing: [XY, XY] | null;
}

/** A polygon sketch ring: placed vertices, then the cursor, then the first vertex again. */
export function splitPolygonSketch(ring: readonly XY[]): PolygonSketchParts {
  if (ring.length < 3) return { placed: ring.slice(0, 1), rubber: null, closing: null };
  const cursor = ring[ring.length - 2]!;
  const placed = ring.slice(0, -2);
  const last = placed[placed.length - 1]!;
  return {
    placed,
    rubber: [last, cursor],
    closing: placed.length >= 2 ? [cursor, ring[0]!] : null,
  };
}
