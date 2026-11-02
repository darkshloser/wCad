// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { Feature, Map as OlMap, View } from 'ol';
import type { FeatureLike } from 'ol/Feature';
import type MapBrowserEvent from 'ol/MapBrowserEvent';
import { Circle as CircleGeom, LineString, MultiPoint, Point, Polygon } from 'ol/geom';
import { DragPan, Draw, Snap } from 'ol/interaction';
import PointerInteraction from 'ol/interaction/Pointer';
import { Vector as VectorLayer } from 'ol/layer';
import TileLayer from 'ol/layer/Tile';
import { Vector as VectorSource } from 'ol/source';
import OSM from 'ol/source/OSM';
import { Circle as CircleStyle, Fill, RegularShape, Stroke, Style } from 'ol/style';
import { Collection } from 'ol';
import { get as getProjection } from 'ol/proj';
import { register } from 'ol/proj/proj4';
import proj4 from 'proj4';

import {
  type Arc,
  type Coord3,
  type ElementKind,
  arcFrom3Points,
  defaultRegistry,
  tessellate,
} from '@wcad/geo-core';
import type { Change, ElementRecord, GeometryStore } from '@wcad/store-contract';
import { type TileScheme, createTileScheme } from '@wcad/tiling';
import { createBackdropLayer } from './backdrop.ts';
import { PerfMonitor, type PerfSnapshot } from './instrumentation.ts';
import {
  type Extent,
  type RectMode,
  type SelectionModifier,
  applySelection,
  clickSelection,
  extentContains,
  isDrag,
  modifierFrom,
  normalizeRect,
  rectMode,
  rightClickDecision,
  sameSelection,
} from './selection.ts';
import {
  type ToolName,
  DEFAULT_TOOL,
  TOOL_GUIDE,
  dedupeConsecutive,
  drawnShapeProblem,
  isDrawingTool,
  keyAction,
  selectionVertices,
} from './toolRules.ts';

export type { ToolName } from './toolRules.ts';

export interface EngineEvents {
  onPointerMove(coord: Coord3): void;
  /**
   * A menu should open (spec §4, §4.1): the object menu for a right-clicked object, or the view menu
   * for empty space. Null asks the shell to close any open menu.
   */
  onContextMenu(payload: ContextMenuRequest | null): void;
  /** The set of selected objects changed. */
  onSelectionChanged(elementIds: readonly string[]): void;
  /** Objects were deleted, so any panel showing them should close. */
  onElementsDeleted(elementIds: readonly string[]): void;
  /** The engine asks the shell to switch tool, e.g. Esc with nothing in progress returns to Select. */
  onRequestTool(tool: ToolName): void;
  onElementsChanged(): void;
  onStatus(message: string): void;
}

export type ContextMenuRequest =
  | { readonly kind: 'object'; readonly elementId: string; readonly pixel: [number, number] }
  | { readonly kind: 'view'; readonly pixel: [number, number] };

/**
 * Backdrop configuration (Phase 2). When absent the map runs working-set only, which is what
 * the Phase 1 demo did and what local-file mode does before its tiles are built.
 */
export interface BackdropConfig {
  readonly tileServiceUrl: string;
  readonly projectExtent: readonly [number, number, number, number];
}

// ------------------------------------------------------------------------------------ styles

const WORKING_STYLE = new Style({
  stroke: new Stroke({ color: '#2b6cb0', width: 2 }),
  fill: new Fill({ color: 'rgba(43, 108, 176, 0.12)' }),
  image: new CircleStyle({ radius: 4, fill: new Fill({ color: '#2b6cb0' }) }),
});

const HOVER_STYLE = new Style({
  stroke: new Stroke({ color: '#3b82f6', width: 3 }),
  fill: new Fill({ color: 'rgba(59, 130, 246, 0.20)' }),
  image: new CircleStyle({ radius: 5, fill: new Fill({ color: '#3b82f6' }) }),
});

const SELECT_COLOR = '#e8590c';

// Two passes: a wide white halo underneath, then the coloured stroke. The halo keeps the
// selection readable over the backdrop and the basemap, whatever colour is beneath it.
const SELECTED_HALO = new Style({
  stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.95)', width: 7 }),
  image: new CircleStyle({ radius: 9, fill: new Fill({ color: 'rgba(255, 255, 255, 0.95)' }) }),
  zIndex: 1,
});

const SELECTED_MAIN = new Style({
  stroke: new Stroke({ color: SELECT_COLOR, width: 3 }),
  fill: new Fill({ color: 'rgba(232, 89, 12, 0.18)' }),
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: SELECT_COLOR }),
    stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
  }),
  zIndex: 2,
});

// Vertex markers show WHERE the vertices are. They are not grips: Select is read-only, and there
// is no interaction on the map that could drag them.
const VERTEX_MARK = new RegularShape({
  points: 4,
  radius: 5,
  angle: Math.PI / 4,
  fill: new Fill({ color: '#ffffff' }),
  stroke: new Stroke({ color: SELECT_COLOR, width: 1.5 }),
});

const SKETCH_STYLE = new Style({
  stroke: new Stroke({ color: '#d69e2e', width: 2, lineDash: [6, 4] }),
  image: new CircleStyle({
    radius: 4,
    fill: new Fill({ color: '#ffffff' }),
    stroke: new Stroke({ color: '#d69e2e', width: 2 }),
  }),
});

const WORKING_Z = 10;

/** State of a left-button gesture in Select mode, from press to release. */
interface SelectGesture {
  readonly startPixel: [number, number];
  readonly modifier: SelectionModifier;
  dragging: boolean;
  cancelled: boolean;
  lastPixel: [number, number];
}

/**
 * Imperative OpenLayers wrapper.
 *
 * React owns the panels; this class owns the canvas. OpenLayers is imperative and fighting it
 * with a declarative re-render model produces subtle interaction bugs, so the boundary is kept
 * explicit and narrow: React calls methods, the engine calls back through EngineEvents.
 *
 * Two layers, deliberately separate (principle P1):
 *   backdrop    — MVT tiles, quantized, generalized, read-only. Holds the millions of objects.
 *   working set — authoritative float64 features. The only thing Draw, Snap and Select touch.
 *
 * Selection behaviour is specified in knowledge/selection-spec.md; the rules themselves live in
 * selection.ts and this class only feeds them events. Select is read-only: there is no Modify or
 * Translate interaction anywhere, so nothing on the map can move a vertex.
 */
export class CadEngine {
  #map: OlMap;
  #workingSource = new VectorSource<Feature>();
  #workingLayer: VectorLayer<VectorSource<Feature>>;
  #sketchSource = new VectorSource<Feature>();
  #snapCollection = new Collection<Feature>();
  #draw: Draw | null = null;
  #sketching = false;
  #snap: Snap;
  #dragPan: DragPan | undefined;
  #selectInteraction: PointerInteraction;
  #gesture: SelectGesture | null = null;
  #rectEl: HTMLDivElement;
  #arcClicks: Coord3[] = [];
  #tool: ToolName = DEFAULT_TOOL;
  #selectedIds: Set<string> = new Set();
  #hoverId: string | null = null;
  #menuTargetId: string | null = null;
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

    // Style is a function of the selection, not baked into features: the working set is rebuilt
    // from the store on every pan, and a highlight stored on a feature would vanish with it.
    this.#workingLayer = new VectorLayer({ source: this.#workingSource, style: this.#styleFor });
    const sketchLayer = new VectorLayer({ source: this.#sketchSource, style: SKETCH_STYLE });

    const projection = getProjection(this.#crsCode) ?? undefined;
    const def = defaultRegistry.get(this.#crsCode);
    const center: [number, number] = [
      (def.extent[0] + def.extent[2]) / 2,
      (def.extent[1] + def.extent[3]) / 2,
    ];

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
          onTileError: (e) => {
            // Every failure is logged in full, so "N tile errors" is never a dead end.
            console.warn(`[wcad] tile failed: HTTP ${e.status || 'no response'} ${e.url} — ${e.message}`);
            const tile = /\/(\d+\/\d+\/\d+)\.mvt/.exec(e.url)?.[1] ?? e.url;
            this.#perf.recordTileError(`${e.status || 'no response'} on tile ${tile}: ${e.message}`);
          },
        }),
      );
    }

    this.#workingLayer.setZIndex(WORKING_Z);
    sketchLayer.setZIndex(25);
    layers.push(this.#workingLayer, sketchLayer);

    this.#map = new OlMap({
      target,
      layers: layers as never,
      view: new View({ projection, center, zoom: 14 }),
      controls: [],
    });

    this.#perf.start();

    // Left-drag pans in Pan and the drawing tools, and draws the selection rectangle in Select.
    this.#dragPan = this.#map
      .getInteractions()
      .getArray()
      .find((i): i is DragPan => i instanceof DragPan);

    // Snap candidates are deliberately NOT drawn. Rendering every nearby vertex as a marker looked
    // exactly like a selection the user never made (spec §6). Draw's own cursor already shows the
    // single snapped position while drawing.
    this.#snap = new Snap({ features: this.#snapCollection });
    this.#map.addInteraction(this.#snap);

    this.#selectInteraction = new PointerInteraction({
      handleDownEvent: this.#onSelectDown,
      handleDragEvent: this.#onSelectDrag,
      handleUpEvent: this.#onSelectUp,
    });
    this.#map.addInteraction(this.#selectInteraction);

    this.#rectEl = document.createElement('div');
    this.#rectEl.className = 'select-rect';
    this.#rectEl.hidden = true;
    this.#map.getViewport().appendChild(this.#rectEl);

    this.#map.on('pointermove', this.#onPointerMove);
    this.#map.on('click', this.#onClick);
    this.#map.on('moveend', () => void this.#reloadViewport());
    const viewport = this.#map.getViewport();
    viewport.addEventListener('contextmenu', this.#onContextMenu);
    viewport.addEventListener('pointerdown', this.#onViewportDown);
    window.addEventListener('pointerup', this.#onViewportUp);
    document.addEventListener('keydown', this.#onKeyDown);

    this.setTool(DEFAULT_TOOL);
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

  get selectedIds(): readonly string[] {
    return [...this.#selectedIds];
  }

  setBasemapVisible(visible: boolean): void {
    this.#basemap.setVisible(visible);
  }

  setTool(tool: ToolName): void {
    this.#tool = tool;
    this.#resetArc();
    this.#cancelGesture();
    this.#setHover(null);
    if (this.#draw) {
      this.#map.removeInteraction(this.#draw);
      this.#draw = null;
    }
    this.#sketching = false;

    const drawing = isDrawingTool(tool);
    // Spec §6: switching to a drawing tool clears the selection. Switching to Pan keeps it.
    if (drawing) this.clearSelection();

    this.#dragPan?.setActive(tool !== 'select');
    this.#selectInteraction.setActive(tool === 'select');
    this.#snap.setActive(drawing);
    if (!drawing) this.#snapCollection.clear();

    this.#setCursor(tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair');
    this.#events.onStatus(TOOL_GUIDE[tool]);

    if (!drawing || tool === 'arc3') return;

    const type = { point: 'Point', line: 'LineString', polygon: 'Polygon', circle: 'Circle' }[
      tool as 'point' | 'line' | 'polygon' | 'circle'
    ] as 'Point' | 'LineString' | 'Polygon' | 'Circle';

    this.#draw = new Draw({
      source: this.#workingSource,
      type,
      stopClick: true,
      ...(tool === 'line' ? { minPoints: 2 } : {}),
      ...(tool === 'polygon' ? { minPoints: 3 } : {}),
    });
    this.#draw.on('drawstart', () => {
      this.#sketching = true;
    });
    this.#draw.on('drawabort', () => {
      this.#sketching = false;
    });
    this.#draw.on('drawend', (evt) => {
      this.#sketching = false;
      void this.#persistDrawn(evt.feature as Feature);
    });
    this.#map.addInteraction(this.#draw);
    // Snap must be added after Draw so it processes pointer events first.
    this.#map.removeInteraction(this.#snap);
    this.#map.addInteraction(this.#snap);
  }

  /**
   * Marks the object an open menu acts on with the hover highlight (spec §4), so it stays clear
   * which object the menu belongs to after the pointer moves onto the menu. Null when it closes.
   */
  setMenuTarget(id: string | null): void {
    if (id === this.#menuTargetId) return;
    this.#menuTargetId = id;
    this.#workingLayer.changed();
  }

  /** Clears the selection and its highlight. */
  clearSelection(): void {
    this.#setSelection(new Set());
  }

  /** Reloads the working set from the store, e.g. after a change made outside the map. */
  refresh(): Promise<void> {
    return this.#reloadViewport();
  }

  /**
   * Deletes objects by id, using the store's current versions so a concurrent edit is reported as
   * a conflict rather than silently overwritten. Deleted ids leave the selection.
   */
  async deleteElements(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const records = await this.#store.getExact([...ids]);
    if (records.length === 0) return 0;
    const res = await this.#store.commit(
      this.#projectId,
      records.map((r): Change => ({ op: 'delete', id: r.id, baseVersion: r.version })),
    );
    if (!res.ok) {
      this.#events.onStatus('Delete rejected: an object changed elsewhere. Reloaded.');
      await this.#reloadViewport();
      return 0;
    }
    const deleted = records.map((r) => r.id);
    const remaining = new Set(this.#selectedIds);
    for (const id of deleted) remaining.delete(id);
    this.#setSelection(remaining);
    await this.#reloadViewport();
    this.#events.onElementsDeleted(deleted);
    this.#events.onStatus(`${deleted.length} object${deleted.length === 1 ? '' : 's'} deleted.`);
    return deleted.length;
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
    if (this.#tool === 'line' || this.#tool === 'polygon') this.#draw?.finishDrawing();
  }

  abortDrawing(): void {
    this.#draw?.abortDrawing();
    this.#sketching = false;
    this.#resetArc();
  }

  zoomToData(): void {
    const extent = this.#workingSource.getExtent();
    if (extent && extent.every(Number.isFinite)) {
      this.#map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 20 });
    }
  }

  dispose(): void {
    this.#perf.stop();
    document.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('pointerup', this.#onViewportUp);
    const viewport = this.#map.getViewport();
    viewport.removeEventListener('contextmenu', this.#onContextMenu);
    viewport.removeEventListener('pointerdown', this.#onViewportDown);
    this.#map.setTarget(undefined);
  }

  // ---------------------------------------------------------------------------- selection state

  #styleFor = (feature: FeatureLike): Style | Style[] => {
    const id = feature.get('elementId') as string | undefined;
    if (id !== undefined && this.#selectedIds.has(id)) return selectedStyle(feature);
    if (id !== undefined && (id === this.#hoverId || id === this.#menuTargetId)) return HOVER_STYLE;
    return WORKING_STYLE;
  };

  /** The only place the selection changes. Every caller is a deliberate user gesture. */
  #setSelection(next: Set<string>): void {
    if (sameSelection(next, this.#selectedIds)) return;
    this.#selectedIds = next;
    this.#workingLayer.changed();
    this.#events.onSelectionChanged([...next]);
    if (this.#tool === 'select') this.#events.onStatus(this.#selectionStatus());
  }

  #selectionStatus(): string {
    const n = this.#selectedIds.size;
    if (n === 0) return TOOL_GUIDE.select;
    if (n === 1) {
      const [id] = this.#selectedIds;
      const kind = this.#workingSource.getFeatures().find((f) => f.get('elementId') === id)?.get('kind') as
        | ElementKind
        | undefined;
      return `${describeKind(kind)} selected (read-only). Esc to clear.`;
    }
    return `${n} objects selected (read-only). Esc to clear.`;
  }

  #setHover(id: string | null): void {
    if (id === this.#hoverId) return;
    this.#hoverId = id;
    this.#workingLayer.changed();
    if (this.#tool === 'select') this.#setCursor(id ? 'pointer' : 'default');
  }

  /**
   * The working-set feature id under a pixel, or null.
   *
   * Never hit-tests the backdrop: its coordinates are quantized, so a "selection" made from it
   * would be subtly wrong and unfixable downstream. Measured, because hover-to-highlight has a
   * 16 ms budget at any drawing size.
   */
  #hitAt(pixel: number[]): string | null {
    return (
      this.#perf.measureHitTest(() =>
        this.#map.forEachFeatureAtPixel(pixel, (f) => (f.get('elementId') as string | undefined) || undefined, {
          hitTolerance: 6,
          layerFilter: (layer) => layer === this.#workingLayer,
        }),
      ) ?? null
    );
  }

  /** Ids of working-set objects selected by a rectangle in map coordinates (spec §3.2). */
  #idsInRect(rect: Extent, mode: RectMode): string[] {
    const ids: string[] = [];
    const extent: [number, number, number, number] = [rect[0], rect[1], rect[2], rect[3]];
    if (mode === 'window') {
      // Fully inside: the object's whole extent lies within the rectangle.
      for (const f of this.#workingSource.getFeaturesInExtent(extent)) {
        const geom = f.getGeometry();
        const id = f.get('elementId') as string | undefined;
        if (geom && id && extentContains(rect, geom.getExtent() as unknown as Extent)) ids.push(id);
      }
    } else {
      // Touching: exact geometry-against-rectangle intersection, not just overlapping extents —
      // otherwise a long diagonal line would be "touched" by a box nowhere near it.
      this.#workingSource.forEachFeatureIntersectingExtent(extent, (f) => {
        const id = f.get('elementId') as string | undefined;
        if (id) ids.push(id);
      });
    }
    return ids;
  }

  // ---------------------------------------------------------------------------- select gestures

  #onSelectDown = (evt: MapBrowserEvent): boolean => {
    const e = evt.originalEvent as PointerEvent;
    if (e.button !== 0) return false;
    this.#gesture = {
      startPixel: [evt.pixel[0]!, evt.pixel[1]!],
      lastPixel: [evt.pixel[0]!, evt.pixel[1]!],
      modifier: modifierFrom(e),
      dragging: false,
      cancelled: false,
    };
    return true;
  };

  #onSelectDrag = (evt: MapBrowserEvent): void => {
    const g = this.#gesture;
    if (!g || g.cancelled) return;
    g.lastPixel = [evt.pixel[0]!, evt.pixel[1]!];
    if (!g.dragging && isDrag(g.startPixel, g.lastPixel)) {
      g.dragging = true;
      this.#setHover(null);
    }
    if (g.dragging) this.#drawRect(g.startPixel, g.lastPixel);
  };

  #onSelectUp = (evt: MapBrowserEvent): boolean => {
    const g = this.#gesture;
    this.#gesture = null;
    this.#hideRect();
    if (!g || g.cancelled) return false;

    const end: [number, number] = [evt.pixel[0]!, evt.pixel[1]!];
    if (!g.dragging) {
      this.#setSelection(clickSelection(this.#selectedIds, this.#hitAt(g.startPixel), g.modifier));
      return false;
    }

    const a = this.#map.getCoordinateFromPixel(g.startPixel);
    const b = this.#map.getCoordinateFromPixel(end);
    if (!a || !b) return false;
    const rect = normalizeRect([a[0]!, a[1]!], [b[0]!, b[1]!]);
    const ids = this.#idsInRect(rect, rectMode(g.startPixel[0], end[0]));
    this.#setSelection(applySelection(this.#selectedIds, ids, g.modifier));
    return false;
  };

  #cancelGesture(): void {
    if (this.#gesture) this.#gesture.cancelled = true;
    this.#hideRect();
  }

  #drawRect(start: [number, number], end: [number, number]): void {
    const el = this.#rectEl;
    el.hidden = false;
    el.className = `select-rect ${rectMode(start[0], end[0])}`;
    el.style.left = `${Math.min(start[0], end[0])}px`;
    el.style.top = `${Math.min(start[1], end[1])}px`;
    el.style.width = `${Math.abs(end[0] - start[0])}px`;
    el.style.height = `${Math.abs(end[1] - start[1])}px`;
  }

  #hideRect(): void {
    this.#rectEl.hidden = true;
  }

  // ---------------------------------------------------------------------------- other input

  #onPointerMove = (evt: MapBrowserEvent): void => {
    const c = evt.coordinate;
    this.#events.onPointerMove([c[0]!, c[1]!, 0]);

    // Hover highlights in every tool, so the user sees what a right-click will act on (spec §3.3).
    if (!evt.dragging && !this.#gesture) this.#setHover(this.#hitAt(evt.pixel));
    if (!isDrawingTool(this.#tool)) return;
    if (this.#tool === 'arc3') this.#renderArcSketch([c[0]!, c[1]!, 0]);
    void this.#refreshSnapCandidates();
  };

  /** Map clicks matter only to the arc tool; Select uses its own gesture, Pan ignores clicks. */
  #onClick = (evt: MapBrowserEvent): void => {
    if (this.#tool === 'arc3') this.#onArcPoint([evt.coordinate[0]!, evt.coordinate[1]!, 0]);
  };

  #onViewportDown = (e: PointerEvent): void => {
    if (this.#tool === 'pan' && e.button === 0) this.#setCursor('grabbing');
  };

  #onViewportUp = (): void => {
    if (this.#tool === 'pan') this.#setCursor('grab');
  };

  #onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const pixel: [number, number] = [e.clientX, e.clientY];
    const decision = rightClickDecision(
      { tool: this.#tool, sketching: this.#sketching },
      this.#hitAt(this.#map.getEventPixel(e)),
      this.#selectedIds,
    );

    switch (decision.kind) {
      case 'finish-shape':
        this.finishDrawing();
        return;
      case 'object-menu':
        this.#setSelection(decision.selection);
        this.setMenuTarget(decision.elementId);
        this.#events.onContextMenu({ kind: 'object', elementId: decision.elementId, pixel });
        return;
      case 'view-menu':
        this.setMenuTarget(null);
        this.#events.onContextMenu({ kind: 'view', pixel });
        return;
    }
  };

  #onKeyDown = (e: KeyboardEvent): void => {
    const action = keyAction(e.key, (e.target as HTMLElement | null)?.tagName);
    if (!action) return;

    if (action === 'cancel') {
      this.#events.onContextMenu(null);
      if (this.#tool === 'select') {
        // Esc during a rectangle drag cancels only the drag; otherwise it deselects everything.
        if (this.#gesture?.dragging && !this.#gesture.cancelled) this.#cancelGesture();
        else this.clearSelection();
      } else if (this.#sketching || this.#arcClicks.length > 0) {
        this.abortDrawing();
        this.#events.onStatus(`Cancelled. ${TOOL_GUIDE[this.#tool]}`);
      } else if (isDrawingTool(this.#tool)) {
        // Nothing in progress: a second Esc leaves the drawing tool, as in most CAD programs.
        this.#events.onRequestTool('select');
      }
      return;
    }

    if (action === 'delete') {
      if (this.#tool === 'select' && this.#selectedIds.size > 0) {
        e.preventDefault();
        this.#events.onContextMenu(null);
        void this.deleteElements([...this.#selectedIds]);
      }
      return;
    }

    if (action === 'finish') {
      if (this.#sketching) {
        e.preventDefault();
        this.finishDrawing();
      }
      return;
    }

    if (action === 'undo-vertex') {
      if (this.#tool === 'arc3' && this.#arcClicks.length > 0) {
        e.preventDefault();
        this.#arcClicks.pop();
        this.#renderArcSketch();
        this.#events.onStatus(`Arc point removed; ${this.#arcClicks.length} of 3 captured.`);
      } else if (this.#sketching && (this.#tool === 'line' || this.#tool === 'polygon')) {
        e.preventDefault();
        this.#draw?.removeLastPoint();
      }
    }
  };

  #setCursor(cursor: string): void {
    this.#map.getViewport().style.cursor = cursor;
  }

  // ---------------------------------------------------------------------------- arc

  #resetArc(): void {
    this.#arcClicks = [];
    this.#sketchSource.clear();
  }

  #onArcPoint(p: Coord3): void {
    this.#arcClicks.push(p);
    this.#renderArcSketch();
    const next = ['', 'Now click a point on the arc.', 'Now click the end point.'][this.#arcClicks.length] ?? '';
    this.#events.onStatus(`Arc point ${this.#arcClicks.length} of 3 captured. ${next}`);
    if (this.#arcClicks.length < 3) return;

    const [a, b, c] = this.#arcClicks as [Coord3, Coord3, Coord3];
    this.#resetArc();
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
   * Rubber-band preview while placing an arc: the clicked points, then a line to the cursor, then
   * the arc itself once two points are known. Without it the arc tool gives no feedback at all
   * until the third click.
   */
  #renderArcSketch(cursor?: Coord3): void {
    this.#sketchSource.clear();
    for (const p of this.#arcClicks) this.#sketchSource.addFeature(new Feature(new Point([p[0], p[1]])));
    if (!cursor || this.#arcClicks.length === 0) return;

    const [a, b] = this.#arcClicks;
    if (this.#arcClicks.length === 1) {
      this.#sketchSource.addFeature(new Feature(new LineString([[a![0], a![1]], [cursor[0], cursor[1]]])));
      return;
    }
    try {
      const arc = arcFrom3Points([a![0], a![1]], [b![0], b![1]], [cursor[0], cursor[1]]);
      const pts = tessellate(arc, this.#displayTolerance());
      this.#sketchSource.addFeature(new Feature(new LineString(pts.map((p) => [p[0], p[1]]))));
    } catch {
      // Collinear or coincident so far: no arc exists yet, so show the straight path instead.
      this.#sketchSource.addFeature(
        new Feature(new LineString([[a![0], a![1]], [b![0], b![1]], [cursor[0], cursor[1]]])),
      );
    }
  }

  // ---------------------------------------------------------------------------- persistence

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
    this.#events.onStatus(`Arc created (r = ${arc.radius.toFixed(3)}). ${TOOL_GUIDE.arc3}`);
  }

  async #persistDrawn(feature: Feature): Promise<void> {
    const geom = feature.getGeometry();
    // The drawn feature is replaced by the reloaded, store-backed one so that the id and
    // version always come from the store rather than being invented on the client.
    this.#workingSource.removeFeature(feature);
    if (!geom) return;

    let coords: number[][];
    let kind: ElementKind;
    let params: Record<string, number> | undefined;
    let radius: number | undefined;

    if (geom instanceof Point) {
      const c = geom.getCoordinates();
      coords = [[c[0]!, c[1]!, 0]];
      kind = 'point';
    } else if (geom instanceof LineString) {
      coords = dedupeConsecutive(geom.getCoordinates()).map((c) => [c[0]!, c[1]!, 0]);
      kind = 'polyline';
    } else if (geom instanceof Polygon) {
      coords = dedupeConsecutive(geom.getCoordinates()[0]!).map((c) => [c[0]!, c[1]!, 0]);
      kind = 'polygon';
    } else if (geom instanceof CircleGeom) {
      const c = geom.getCenter();
      radius = geom.getRadius();
      coords = [[c[0]! + radius, c[1]!, 0]];
      kind = 'circle';
      params = { cx: c[0]!, cy: c[1]!, r: radius };
    } else {
      this.#events.onStatus('Unsupported geometry type.');
      return;
    }

    const problem = drawnShapeProblem(kind, coords, radius);
    if (problem) {
      this.#events.onStatus(`Not created: ${problem}`);
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
    this.#events.onStatus(`${describeKind(kind)} created. ${TOOL_GUIDE[this.#tool]}`);
  }

  /** Tessellation tolerance derived from the current pixel size, so detail follows zoom. */
  #displayTolerance(): number {
    const res = this.#map.getView().getResolution() ?? 1;
    return Math.max(res * 0.5, 1e-6);
  }

  /**
   * Rebuilds the working set for the current view. It never touches the selection: selection is
   * held by id, so objects keep their highlight across pans and zooms (spec §6).
   */
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
   * They feed the Snap interaction only and are never rendered.
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
    if (!isDrawingTool(this.#tool)) return;
    this.#snapCollection.clear();
    for (const c of candidates) {
      const f = new Feature(new Point([c.x, c.y]));
      f.set('role', c.role);
      this.#snapCollection.push(f);
    }
  }
}

/** Highlight for a selected object: halo, coloured outline, and markers on its real vertices. */
function selectedStyle(feature: FeatureLike): Style[] {
  const geom = feature.getGeometry();
  let drawn: number[][] = [];
  let center: [number, number] | undefined;
  if (geom instanceof LineString) drawn = geom.getCoordinates();
  else if (geom instanceof Polygon) drawn = geom.getCoordinates()[0] ?? [];
  else if (geom instanceof CircleGeom) {
    const c = geom.getCenter();
    center = [c[0]!, c[1]!];
  }

  const vertices = selectionVertices(feature.get('kind') as ElementKind, drawn, center);
  if (vertices.length === 0) return [SELECTED_HALO, SELECTED_MAIN];
  return [SELECTED_HALO, SELECTED_MAIN, new Style({ geometry: new MultiPoint(vertices), image: VERTEX_MARK, zIndex: 3 })];
}

function describeKind(kind: ElementKind | undefined): string {
  switch (kind) {
    case 'point':
      return 'Point';
    case 'line':
    case 'polyline':
      return 'Polyline';
    case 'polygon':
      return 'Polygon';
    case 'circle':
      return 'Circle';
    case 'arc':
      return 'Arc';
    default:
      return 'Object';
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
