// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CoordinateInputError,
  type Coord3,
  defaultRegistry,
  formatCoordinate,
  parseCoordinateInput,
  resolveInput,
} from '@wcad/geo-core';
import { MemoryStore } from '@wcad/store-contract';
import type { ElementRecord, GeometryStore } from '@wcad/store-contract';
import { CadEngine, type ToolName } from './map/engine.ts';
import type { PerfSnapshot } from './map/instrumentation.ts';
import { Toolbar } from './components/Toolbar.tsx';
import { PropertiesPanel } from './components/PropertiesPanel.tsx';
import { CommandLine } from './components/CommandLine.tsx';
import { StatusBar } from './components/StatusBar.tsx';

/**
 * Tile service location. When it is not configured, or when it has no projects, the map runs
 * working-set only on the in-memory store — the app degrades to Phase 1 behaviour rather than
 * failing, which is also exactly how local-file mode will behave in Phase 6.
 */
const TILE_SERVICE_URL = (import.meta.env['VITE_TILE_SERVICE_URL'] as string | undefined) ?? '';

const LOCAL_PROJECT_ID = 'demo';

interface ProjectInfo {
  id: string;
  name: string;
  crs: string;
  extent: [number, number, number, number];
  elementCount: number;
}

/**
 * Project discovery.
 *
 * The project id, CRS and extent all come from the tile service, so the client builds a tile
 * grid identical to the server's. Hardcoding them on both sides is the classic way to end up
 * requesting tiles that do not exist while everything looks correctly configured.
 */
async function discoverProject(signal: AbortSignal): Promise<ProjectInfo | null> {
  if (!TILE_SERVICE_URL) return null;
  const wanted = new URLSearchParams(window.location.search).get('project');
  try {
    const res = await fetch(`${TILE_SERVICE_URL}/projects`, { signal });
    if (!res.ok) return null;
    const { projects } = (await res.json()) as { projects: ProjectInfo[] };
    if (projects.length === 0) return null;
    return projects.find((p) => p.id === wanted) ?? projects[0]!;
  } catch {
    return null;
  }
}

/**
 * Phase 1 demo shell.
 *
 * It runs entirely on the in-memory reference store, which is the point: the UI talks to the
 * GeometryStore contract, so swapping in the PostGIS-backed remote store (Phase 2) or the
 * SQLite-WASM local store (Phase 6) changes one line here and nothing else.
 */
export function App() {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CadEngine | null>(null);
  const storeRef = useRef<GeometryStore | null>(null);

  const [crs, setCrs] = useState('EPSG:32635');
  const [tool, setTool] = useState<ToolName>('select');
  const [cursor, setCursor] = useState<Coord3>([0, 0, 0]);
  const [status, setStatus] = useState('Ready.');
  const [basemap, setBasemap] = useState(false);
  const [selected, setSelected] = useState<ElementRecord | null>(null);
  const [menuAt, setMenuAt] = useState<[number, number] | null>(null);
  const [count, setCount] = useState(0);
  const [lastPoint, setLastPoint] = useState<Coord3 | null>(null);
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [discovered, setDiscovered] = useState(false);

  // Discovery runs once, before the map is built, because the CRS and extent it returns decide
  // how the map is constructed.
  useEffect(() => {
    const ac = new AbortController();
    void discoverProject(ac.signal).then((p) => {
      setProject(p);
      if (p) {
        setCrs(p.crs);
        setStatus(`Project "${p.name}" — ${p.elementCount.toLocaleString()} elements from the tile service.`);
      } else if (TILE_SERVICE_URL) {
        setStatus('Tile service reachable but has no projects yet. Run: make seed');
      }
      setDiscovered(true);
    });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (!mapRef.current || !discovered) return;
    let disposed = false;
    let engine: CadEngine | null = null;

    void (async () => {
      const store = storeRef.current ?? (await MemoryStore.create());
      storeRef.current = store;
      if (disposed || !mapRef.current) return;

      engine = new CadEngine(
        mapRef.current,
        store,
        project?.id ?? LOCAL_PROJECT_ID,
        crs,
        {
        onPointerMove: setCursor,
        onContextMenu: (payload) => {
          if (!payload) {
            setMenuAt(null);
            setSelected(null);
            return;
          }
          void (async () => {
            const [rec] = await store.getExact([payload.elementId]);
            if (!rec) return;
            const metadata = await store.getMetadata(rec.id);
            setSelected({ ...rec, metadata });
            setMenuAt(payload.pixel);
          })();
        },
          onElementsChanged: () => void store.count(LOCAL_PROJECT_ID).then(setCount),
          onStatus: setStatus,
        },
        TILE_SERVICE_URL && project
          ? { tileServiceUrl: TILE_SERVICE_URL, projectExtent: project.extent }
          : undefined,
      );
      engineRef.current = engine;
      engine.setBasemapVisible(basemap);
      engine.setTool(tool);
    })();

    return () => {
      disposed = true;
      engine?.dispose();
      engineRef.current = null;
    };
    // Rebuilding the map on CRS change is correct: a project has one active CRS and data is
    // never implicitly reprojected at rest (architecture doc section 9).
  }, [crs, discovered, project]);

  useEffect(() => {
    engineRef.current?.setTool(tool);
  }, [tool]);

  // Polled rather than pushed: a state update per frame would itself cost frames.
  useEffect(() => {
    const id = window.setInterval(() => setPerf(engineRef.current?.perfSnapshot() ?? null), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    engineRef.current?.setBasemapVisible(basemap);
  }, [basemap]);

  const submitCoordinate = useCallback(
    (text: string) => {
      try {
        const parsed = parseCoordinateInput(text);
        const point = resolveInput(parsed, lastPoint);
        engineRef.current?.addTypedPoint(point);
        setLastPoint(point);
      } catch (err) {
        if (err instanceof CoordinateInputError) setStatus(err.message);
        else throw err;
      }
    },
    [lastPoint],
  );

  const saveMetadata = useCallback(async (id: string, metadata: Record<string, unknown>) => {
    const store = storeRef.current;
    if (!store) return;
    const [rec] = await store.getExact([id]);
    if (!rec) return;
    const res = await store.commit(LOCAL_PROJECT_ID, [
      { op: 'update', id, baseVersion: rec.version, element: { metadata } },
    ]);
    setStatus(res.ok ? 'Metadata saved.' : 'Metadata rejected: element changed elsewhere.');
    if (res.ok) {
      const [updated] = await store.getExact([id]);
      if (updated) setSelected({ ...updated, metadata });
    }
  }, []);

  const deleteSelected = useCallback(async () => {
    const store = storeRef.current;
    if (!store || !selected) return;
    await store.commit(LOCAL_PROJECT_ID, [{ op: 'delete', id: selected.id, baseVersion: selected.version }]);
    setSelected(null);
    setMenuAt(null);
    setStatus('Element deleted.');
  }, [selected]);

  const axisLabels = defaultRegistry.axisLabels(crs);

  return (
    <div className="app">
      <Toolbar
        tool={tool}
        onTool={setTool}
        crs={crs}
        onCrs={setCrs}
        basemap={basemap}
        onBasemap={setBasemap}
        onFinish={() => engineRef.current?.finishDrawing()}
        onAbort={() => engineRef.current?.abortDrawing()}
        onZoomToData={() => engineRef.current?.zoomToData()}
      />

      <div className="workspace">
        <div className="map" ref={mapRef} />
        {menuAt && selected && (
          <div className="context-menu" style={{ left: menuAt[0], top: menuAt[1] }}>
            <button onClick={() => setMenuAt(null)}>Properties</button>
            <button onClick={() => void deleteSelected()}>Delete</button>
          </div>
        )}
        <PropertiesPanel
          element={selected}
          axisLabels={axisLabels}
          onClose={() => setSelected(null)}
          onSaveMetadata={saveMetadata}
        />
      </div>

      <CommandLine onSubmit={submitCoordinate} axisLabels={axisLabels} />
      <StatusBar
        message={status}
        coordinate={formatCoordinate(cursor, axisLabels)}
        crs={crs}
        elementCount={count}
        perf={perf}
      />
    </div>
  );
}
