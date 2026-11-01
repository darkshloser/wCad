// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { Feature, Map as OlMap, View } from 'ol';
import { Circle as CircleGeom, LineString, Point, Polygon } from 'ol/geom';
import { Draw, Modify, Snap } from 'ol/interaction';
import { Vector as VectorLayer } from 'ol/layer';
import TileLayer from 'ol/layer/Tile';
import { Vector as VectorSource } from 'ol/source';
import OSM from 'ol/source/OSM';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';
import { Collection } from 'ol';
import { get as getProjection } from 'ol/proj';
import { register } from 'ol/proj/proj4';
import proj4 from 'proj4';

import {
  type Arc,
  type Coord3,
  arcFrom3Points,
  defaultRegistry,
  tessellate,
} from '@wcad/geo-core';
import type { Change, ElementRecord, GeometryStore } from '@wcad/store-contract';
import { type TileScheme, createTileScheme } from '@wcad/tiling';
import { createBackdropLayer } from './backdrop.ts';
import { PerfMonitor, type PerfSnapshot } from './instrumentation.ts';

export type ToolName = 'select' | 'point' | 'line' | 'polygon' | 'circle' | 'arc3';

export interface EngineEvents {
  onPointerMove(coord: Coord3): void;
  onContextMenu(payload: { elementId: string; pixel: [number, number] } | null): void;
  onElementsChanged(): void;
  onStatus(message: string): void;
}

/**
 * Backdrop configuration (Phase 2). When absent the map runs working-set only, which is what
 * the Phase 1 demo did and what local-file mode does before its tiles are built.
 */
export interface BackdropConfig {
  readonly tileServiceUrl: string;
  readonly projectExtent: readonly [number, number, number, number];
}

const WORKING_STYLE = new Style({
  stroke: new Stroke({ color: '#2b6cb0', width: 2 }),
  fill: new Fill({ color: 'rgba(43, 108, 176, 0.12)' }),
  image: new CircleStyle({ radius: 4, fill: new Fill({ color: '#2b6cb0' }) }),
});

const SNAP_STYLE = new Style({
  image: new CircleStyle({
    radius: 5,
    stroke: new Stroke({ color: '#d69e2e', width: 2 }),
    fill: new Fill({ color: 'rgba(214, 158, 46, 0.35)' }),
  }),
});

/**
 * Imperative OpenLayers wrapper.
 *
 * React owns the panels; this class owns the canvas. OpenLayers is imperative and fighting it
 * with a declarative re-render model produces subtle interaction bugs, so the boundary is kept
 * explicit and narrow: React calls methods, the engine calls back through EngineEvents.
 *
 * Two layers, deliberately separate (principle P1):
 *   backdrop    — MVT tiles, quantized, generalized, read-only. Holds the millions of objects.
 *   working set — authoritative float64 features. The only thing Draw, Modify and Snap touch.
 *
 * Hit-testing is filtered to the working set so a click can never select tile geometry.
 */
export class CadEngine {
  #map: OlMap;
  #workingSource = new VectorSource<Feature>();
  #snapSource = new VectorSource<Feature>();
  #snapCollection = new Collection<Feature>();
  #draw: Draw | null = null;
  #modify: Modify;
  #snap: Snap;
  #arcClicks: Coord3[] = [];
  #tool: ToolName = 'select';
  #basemap: TileLayer<OSM>;
  #perf = new PerfMonitor();
  #scheme: TileScheme | null = null;

  // Explicit fields, not constructor parameter properties. Vite's esbuild handles parameter
  // properties, but the rest of the codebase runs under `node --experimental-strip-types`, which
  // does not — keeping one style everywhere means this file stays safe to import from a tool.
  readonly #store: GeometryStore;
  #projectId: string;
  #crsCode: string;
  readonly #events: EngineEvents;

  constructor(
    target: HTMLElement,
    store: GeometryStore,
    projectId: string,
    crsCode: string,
    events: EngineEvents,
    backdrop?: BackdropConfig,
  ) {
    this.#store = store;
    this.#projectId = projectId;
    this.#crsCode = crsCode;
    this.#events = events;
    registerProjections();

    this.#basemap = new TileLayer({ source: new OSM(), visible: false, opacity: 0.6 });

    const workingLayer = new VectorLayer({ source: this.#workingSource, style: WORKING_STYLE });
    const snapLayer = new VectorLayer({ source: this.#snapSource, style: SNAP_STYLE });

    const projection = getProjection(this.#crsCode) ?? undefined;
    const def = defaultRegistry.get(this.#crsCode);
    const center: [number, number] = [
      (def.extent[0] + def.extent[2]) / 2,
      (def.extent[1] + def.extent[3]) / 2,
    ];

    // The backdrop carries the millions of objects and is read-only by construction; the
    // working set carries the handful the user can actually touch (principle P1).
    const layers: Array<TileLayer<OSM> | VectorLayer<VectorSource<Feature>> | ReturnType<typeof createBackdropLayer>> =
      [this.#basemap];

    if (backdrop) {
      this.#scheme = createTileScheme(this.#crsCode, backdrop.projectExtent as [number, number, number, number], {
        maxZoom: 24,
      });
      layers.push(
        createBackdropLayer({
          scheme: this.#scheme,
          projectId: this.#projectId,
          tileServiceUrl: backdrop.tileServiceUrl,
          onTileLoad: (ms) => this.#perf.recordTileLoad(ms),
          onTileError: () => this.#perf.recordTileError(),
        }),
      );
    }

    workingLayer.setZIndex(10);
    snapLayer.setZIndex(20);
    layers.push(workingLayer, snapLayer);

    this.#map = new OlMap({
      target,
      layers: layers as never,
      view: new View({ projection, center, zoom: 14 }),
      controls: [],
    });

    this.#perf.start();

    this.#modify = new Modify({ source: this.#workingSource });
    this.#snap = new Snap({ features: this.#snapCollection });
    this.#map.addInteraction(this.#modify);
    this.#map.addInteraction(this.#snap);

    this.#map.on('pointermove', (evt) => {
      const c = evt.coordinate;
      this.#events.onPointerMove([c[0]!, c[1]!, 0]);
      void this.#refreshSnapCandidates();
    });

    this.#map.on('moveend', () => void this.#reloadViewport());

    this.#map.getViewport().addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const browserEvent = e as MouseEvent;
      const pixel = this.#map.getEventPixel(browserEvent);
      // Measured: the interaction budget is 16 ms with zero network, at any drawing size.
      const hit = this.#perf.measureHitTest(() =>
        this.#map.forEachFeatureAtPixel(pixel, (f) => f as Feature, {
          hitTolerance: 6,
          // Never hit-test the backdrop: its coordinates are quantized, so a "selection" made
          // from it would be subtly wrong and unfixable downstream.
          layerFilter: (layer) => layer.getZIndex() === 10,
        }),
      );
      const id = hit?.get('elementId') as string | undefined;
      this.#events.onContextMenu(id ? { elementId: id, pixel: [browserEvent.clientX, browserEvent.clientY] } : null);
    });

    this.#modify.on('modifyend', (evt) => {
      void this.#persistModified(evt.features.getArray() as Feature[]);
    });

    void this.#reloadViewport();
  }

  get map(): OlMap {
    return this.#map;
  }

  /** Live performance counters, matching the budgets in the architecture document. */
  perfSnapshot(): PerfSnapshot {
    return this.#perf.snapshot();
  }

  get tileScheme(): TileScheme | null {
    return this.#scheme;
  }

  setBasemapVisible(visible: boolean): void {
    this.#basemap.setVisible(visible);
  }

  setTool(tool: ToolName): void {
    this.#tool = tool;
    this.#arcClicks = [];
    if (this.#draw) {
      this.#map.removeInteraction(this.#draw);
      this.#draw = null;
    }
    this.#map.un('click', this.#onArcClick);

    if (tool === 'select') {
      this.#events.onStatus('Select mode. Right-click an element for properties.');
      return;
    }
    if (tool === 'arc3') {
      this.#map.on('click', this.#onArcClick);
      this.#events.onStatus('Arc: click start, a point on the arc, then end.');
      return;
    }

    const type = { point: 'Point', line: 'LineString', polygon: 'Polygon', circle: 'Circle' }[tool] as
      | 'Point'
      | 'LineString'
      | 'Polygon'
      | 'Circle';

    this.#draw = new Draw({ source: this.#workingSource, type });
    this.#draw.on('drawend', (evt) => void this.#persistDrawn(evt.feature as Feature));
    this.#map.addInteraction(this.#draw);
    // Snap must be added after Draw so it processes pointer events first.
    this.#map.removeInteraction(this.#snap);
    this.#map.addInteraction(this.#snap);
    this.#events.onStatus(`${tool} tool active. Snapping to existing vertices is on.`);
  }

  /** Adds a point from the typed command line, so typed and mouse entry share one path. */
  addTypedPoint(point: Coord3): void {
    if (this.#tool === 'arc3') {
      this.#onArcPoint(point);
      return;
    }
    if (this.#draw) {
      this.#draw.appendCoordinates([[point[0], point[1]]]);
      this.#events.onStatus(`Appended ${point[0].toFixed(3)}, ${point[1].toFixed(3)}`);
      return;
    }
    this.#events.onStatus('Select a drawing tool before entering coordinates.');
  }

  finishDrawing(): void {
    this.#draw?.finishDrawing();
  }

  abortDrawing(): void {
    this.#draw?.abortDrawing();
    this.#arcClicks = [];
  }

  zoomToData(): void {
    const extent = this.#workingSource.getExtent();
    if (extent.every(Number.isFinite) && extent[0] !== Infinity) {
      this.#map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 20 });
    }
  }

  dispose(): void {
    this.#perf.stop();
    this.#map.setTarget(undefined);
  }

  #onArcClick = (evt: { coordinate: number[] }): void => {
    this.#onArcPoint([evt.coordinate[0]!, evt.coordinate[1]!, 0]);
  };

  #onArcPoint(p: Coord3): void {
    this.#arcClicks.push(p);
    this.#events.onStatus(`Arc point ${this.#arcClicks.length} of 3 captured.`);
    if (this.#arcClicks.length < 3) return;

    const [a, b, c] = this.#arcClicks as [Coord3, Coord3, Coord3];
    this.#arcClicks = [];
    let arc: Arc;
    try {
      arc = arcFrom3Points([a[0], a[1]], [b[0], b[1]], [c[0], c[1]]);
    } catch (err) {
      this.#events.onStatus(`Arc rejected: ${(err as Error).message}`);
      return;
    }
    void this.#persistArc(arc);
  }

  /**
   * Arcs are stored as their canonical parametric definition and tessellated only for display
   * (principle P1). The stored endpoints come from the exact arc, not from the click positions,
   * so they remain valid snap targets.
   */
  async #persistArc(arc: Arc): Promise<void> {
    const tolerance = this.#displayTolerance();
    const pts = tessellate(arc, tolerance);
    const change: Change = {
      op: 'create',
      element: {
        projectId: this.#projectId,
        layerId: 'default',
        kind: 'arc',
        crs: this.#crsCode,
        coords: [
          [pts[0]![0], pts[0]![1], 0],
          [pts[pts.length - 1]![0], pts[pts.length - 1]![1], 0],
        ],
        params: {
          cx: arc.center[0],
          cy: arc.center[1],
          r: arc.radius,
          startAngle: arc.startAngle,
          endAngle: arc.endAngle,
          ccw: arc.ccw ? 1 : 0,
        },
      },
    };
    const res = await this.#store.commit(this.#projectId, [change]);
    if (!res.ok) {
      this.#events.onStatus('Arc commit rejected.');
      return;
    }
    await this.#reloadViewport();
    this.#events.onStatus(`Arc created (r = ${arc.radius.toFixed(3)}).`);
  }

  async #persistDrawn(feature: Feature): Promise<void> {
    const geom = feature.getGeometry();
    if (!geom) return;
    // The drawn feature is replaced by the reloaded, store-backed one so that the id and
    // version always come from the store rather than being invented on the client.
    this.#workingSource.removeFeature(feature);

    let coords: number[][];
    let kind: ElementRecord['kind'];
    let params: Record<string, number> | undefined;

    if (geom instanceof Point) {
      const c = geom.getCoordinates();
      coords = [[c[0]!, c[1]!, 0]];
      kind = 'point';
    } else if (geom instanceof LineString) {
      coords = geom.getCoordinates().map((c) => [c[0]!, c[1]!, 0]);
      kind = 'polyline';
    } else if (geom instanceof Polygon) {
      coords = geom.getCoordinates()[0]!.map((c) => [c[0]!, c[1]!, 0]);
      kind = 'polygon';
    } else if (geom instanceof CircleGeom) {
      const c = geom.getCenter();
      const r = geom.getRadius();
      coords = [[c[0]! + r, c[1]!, 0]];
      kind = 'circle';
      params = { cx: c[0]!, cy: c[1]!, r };
    } else {
      this.#events.onStatus('Unsupported geometry type.');
      return;
    }

    const res = await this.#store.commit(this.#projectId, [
      {
        op: 'create',
        element: {
          projectId: this.#projectId,
          layerId: 'default',
          kind,
          crs: this.#crsCode,
          coords,
          ...(params ? { params } : {}),
        },
      },
    ]);
    if (!res.ok) {
      this.#events.onStatus('Commit rejected.');
      return;
    }
    await this.#reloadViewport();
    this.#events.onStatus(`${kind} created.`);
  }

  async #persistModified(features: Feature[]): Promise<void> {
    const changes: Change[] = [];
    for (const f of features) {
      const id = f.get('elementId') as string | undefined;
      const version = f.get('version') as number | undefined;
      const geom = f.getGeometry();
      if (!id || version === undefined || !geom) continue;
      let coords: number[][] | null = null;
      if (geom instanceof LineString) coords = geom.getCoordinates().map((c) => [c[0]!, c[1]!, 0]);
      else if (geom instanceof Polygon) coords = geom.getCoordinates()[0]!.map((c) => [c[0]!, c[1]!, 0]);
      else if (geom instanceof Point) coords = [[geom.getCoordinates()[0]!, geom.getCoordinates()[1]!, 0]];
      if (!coords) continue;
      changes.push({ op: 'update', id, baseVersion: version, element: { coords } });
    }
    if (changes.length === 0) return;
    const res = await this.#store.commit(this.#projectId, changes);
    if (!res.ok) {
      this.#events.onStatus(
        `Edit rejected: element changed elsewhere (expected v${res.conflicts[0]?.expectedVersion}, found v${res.conflicts[0]?.actualVersion}). Reloading.`,
      );
    }
    await this.#reloadViewport();
  }

  /** Tessellation tolerance derived from the current pixel size, so detail follows zoom. */
  #displayTolerance(): number {
    const res = this.#map.getView().getResolution() ?? 1;
    return Math.max(res * 0.5, 1e-6);
  }

  async #reloadViewport(): Promise<void> {
    const extent = this.#map.getView().calculateExtent(this.#map.getSize() ?? [800, 600]);
    const records = await this.#store.queryBBox(this.#projectId, [
      extent[0]!,
      extent[1]!,
      extent[2]!,
      extent[3]!,
    ]);
    this.#workingSource.clear();
    const tolerance = this.#displayTolerance();
    for (const rec of records) {
      const feature = toFeature(rec, tolerance);
      if (feature) this.#workingSource.addFeature(feature);
    }
    this.#events.onElementsChanged();
  }

  /**
   * Snap candidates come from the store, bounded and proximity-ordered, and are held in a small
   * collection rather than pointing Snap at the whole drawing (architecture doc section 6.2).
   */
  async #refreshSnapCandidates(): Promise<void> {
    const view = this.#map.getView();
    const centerCoord = view.getCenter();
    if (!centerCoord) return;
    const res = view.getResolution() ?? 1;
    const margin = res * 200;
    const bbox: [number, number, number, number] = [
      centerCoord[0]! - margin,
      centerCoord[1]! - margin,
      centerCoord[0]! + margin,
      centerCoord[1]! + margin,
    ];
    const candidates = await this.#store.snapCandidates(this.#projectId, bbox, 500);
    this.#snapSource.clear();
    this.#snapCollection.clear();
    for (const c of candidates) {
      const f = new Feature(new Point([c.x, c.y]));
      f.set('role', c.role);
      this.#snapSource.addFeature(f);
      this.#snapCollection.push(f);
    }
  }
}

function toFeature(rec: ElementRecord, tolerance: number): Feature | null {
  let feature: Feature | null = null;
  const xy = rec.coords.map((c) => [c[0]!, c[1]!]);

  if (rec.kind === 'arc' && rec.params) {
    const arc: Arc = {
      center: [rec.params['cx']!, rec.params['cy']!],
      radius: rec.params['r']!,
      startAngle: rec.params['startAngle']!,
      endAngle: rec.params['endAngle']!,
      ccw: rec.params['ccw'] === 1,
    };
    feature = new Feature(new LineString(tessellate(arc, tolerance).map((p) => [p[0], p[1]])));
  } else if (rec.kind === 'circle' && rec.params) {
    feature = new Feature(new CircleGeom([rec.params['cx']!, rec.params['cy']!], rec.params['r']!));
  } else if (rec.kind === 'point') {
    feature = new Feature(new Point(xy[0]!));
  } else if (rec.kind === 'polygon') {
    feature = new Feature(new Polygon([xy]));
  } else {
    feature = new Feature(new LineString(xy));
  }

  feature.set('elementId', rec.id);
  feature.set('version', rec.version);
  feature.set('kind', rec.kind);
  return feature;
}

let registered = false;
function registerProjections(): void {
  if (registered) return;
  for (const def of defaultRegistry.list()) {
    if (def.proj4) proj4.defs(def.code, def.proj4);
  }
  register(proj4);
  registered = true;
}
