// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

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
import { Toolbar } from './components/Toolbar.tsx';
import { PropertiesPanel } from './components/PropertiesPanel.tsx';
import { CommandLine } from './components/CommandLine.tsx';
import { StatusBar } from './components/StatusBar.tsx';

const PROJECT_ID = 'demo';

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

  useEffect(() => {
    if (!mapRef.current) return;
    let disposed = false;
    let engine: CadEngine | null = null;

    void (async () => {
      const store = storeRef.current ?? (await MemoryStore.create());
      storeRef.current = store;
      if (disposed || !mapRef.current) return;

      engine = new CadEngine(mapRef.current, store, PROJECT_ID, crs, {
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
        onElementsChanged: () => void store.count(PROJECT_ID).then(setCount),
        onStatus: setStatus,
      });
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
  }, [crs]);

  useEffect(() => {
    engineRef.current?.setTool(tool);
  }, [tool]);

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
    const res = await store.commit(PROJECT_ID, [
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
    await store.commit(PROJECT_ID, [{ op: 'delete', id: selected.id, baseVersion: selected.version }]);
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
      />
    </div>
  );
}
