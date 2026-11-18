// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { FeatureLike } from 'ol/Feature';
import { Circle as CircleGeom, LineString, MultiPoint, Point, Polygon } from 'ol/geom';
import { Fill, RegularShape, Stroke, Style } from 'ol/style';
import { type Background, sketchColours, splitOpenSketch, splitPolygonSketch } from './sketchGeometry.ts';

/** Role of a feature the engine draws itself (Line and Arc tools) in the sketch layer. */
export type SketchRole = 'vertex' | 'rubber' | 'cursor';

export interface SketchContext {
  /** A snap target is shown: hide the crosshair (spec §4). */
  readonly snapped: boolean;
  /** Current (snapped) cursor position, for the circle radius guide. */
  readonly cursor: readonly number[] | null;
}

/**
 * The single in-progress style (knowledge/drawing-style-spec.md, option B "white construction").
 *
 * One instance per background. Every drawing tool goes through it: OpenLayers' Draw via
 * `forDraw`, the engine's own Line/Arc sketches via `forRole`.
 */
export class SketchStyles {
  readonly #placed: Style;
  readonly #rubber: Style;
  readonly #vertex: RegularShape;
  readonly #cursor: Style;
  readonly #fill: Style;
  readonly #vertexStyle: Style;

  constructor(bg: Background) {
    const c = sketchColours(bg);
    this.#placed = new Style({ stroke: new Stroke({ color: c.stroke, width: 2 }) });
    this.#rubber = new Style({ stroke: new Stroke({ color: c.stroke, width: 1.5, lineDash: [6, 5] }) });
    this.#vertex = new RegularShape({
      points: 4,
      radius: 5.66, // an 8 px square
      angle: Math.PI / 4,
      fill: new Fill({ color: c.vertexFill }),
      stroke: new Stroke({ color: c.stroke, width: 1.5 }),
    });
    this.#vertexStyle = new Style({ image: this.#vertex, zIndex: 2 });
    this.#cursor = new Style({
      image: new RegularShape({ points: 4, radius: 8, radius2: 0, angle: 0, stroke: new Stroke({ color: c.stroke, width: 1.5 }) }),
      zIndex: 3,
    });
    this.#fill = new Style({ fill: new Fill({ color: c.fill }) });
  }

  /** Engine-drawn sketch features (Line and Arc tools), tagged with a role. */
  forRole(feature: FeatureLike, ctx: SketchContext): Style | Style[] {
    switch (feature.get('role') as SketchRole) {
      case 'vertex':
        return this.#vertexStyle;
      case 'cursor':
        return ctx.snapped ? [] : this.#cursor;
      default:
        return this.#rubber;
    }
  }

  /** OpenLayers Draw sketch features (Point, Polyline, Polygon, Circle tools). */
  forDraw(feature: FeatureLike, tool: string, ctx: SketchContext): Style[] {
    const geom = feature.getGeometry();

    if (geom instanceof Point) return ctx.snapped ? [] : [this.#cursor];

    if (geom instanceof LineString) {
      // In Polygon mode OpenLayers also draws a helper line; the polygon ring already carries
      // every part, so drawing both would double the strokes.
      if (tool === 'polygon') return [];
      return this.#openParts(splitOpenSketch(geom.getCoordinates()));
    }

    if (geom instanceof Polygon) {
      const parts = splitPolygonSketch(geom.getCoordinates()[0] ?? []);
      const styles = [this.#fill, ...this.#openParts(parts)];
      if (parts.closing) styles.push(this.#with(this.#rubber, new LineString(coords(parts.closing))));
      return styles;
    }

    if (geom instanceof CircleGeom) {
      const center = geom.getCenter();
      const styles = [this.#rubber, this.#with(this.#vertexStyle, new Point(center))];
      if (ctx.cursor) styles.push(this.#with(this.#rubber, new LineString([center, [ctx.cursor[0]!, ctx.cursor[1]!]])));
      return styles;
    }

    return [this.#rubber];
  }

  #openParts(parts: { placed: readonly (readonly number[])[]; rubber: [readonly number[], readonly number[]] | null }): Style[] {
    const out: Style[] = [];
    if (parts.placed.length >= 2) out.push(this.#with(this.#placed, new LineString(coords(parts.placed))));
    if (parts.rubber) out.push(this.#with(this.#rubber, new LineString(coords(parts.rubber))));
    if (parts.placed.length > 0) out.push(this.#with(this.#vertexStyle, new MultiPoint(coords(parts.placed))));
    return out;
  }

  /** A copy of a style bound to a specific geometry. */
  #with(base: Style, geometry: LineString | Point | MultiPoint): Style {
    const s = base.clone();
    s.setGeometry(geometry);
    return s;
  }
}

/** Mutable copies for OpenLayers geometry constructors. */
function coords(pts: readonly (readonly number[])[]): number[][] {
  return pts.map((p) => [...p]);
}
