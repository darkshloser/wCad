// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import { defaultRegistry } from '@wcad/geo-core';
import type { ToolName } from '../map/engine.ts';

const TOOLS: Array<{ id: ToolName; label: string; hint: string }> = [
  { id: 'select', label: 'Select', hint: 'Select and right-click for properties' },
  { id: 'point', label: 'Point', hint: 'Place a point' },
  { id: 'line', label: 'Polyline', hint: 'Draw a polyline' },
  { id: 'polygon', label: 'Polygon', hint: 'Draw a closed polygon' },
  { id: 'circle', label: 'Circle', hint: 'Draw a circle by centre and radius' },
  { id: 'arc3', label: 'Arc (3 pt)', hint: 'Start, point on arc, end' },
];

export function Toolbar(props: {
  tool: ToolName;
  onTool: (t: ToolName) => void;
  crs: string;
  onCrs: (c: string) => void;
  basemap: boolean;
  onBasemap: (v: boolean) => void;
  onFinish: () => void;
  onAbort: () => void;
  onZoomToData: () => void;
}) {
  return (
    <header className="toolbar">
      <span className="brand">wCAD</span>

      <div className="group">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            title={t.hint}
            className={props.tool === t.id ? 'active' : ''}
            onClick={() => props.onTool(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="group">
        <button onClick={props.onFinish} title="Finish the current geometry (Enter)">
          Finish
        </button>
        <button onClick={props.onAbort} title="Abort the current geometry (Esc)">
          Cancel
        </button>
        <button onClick={props.onZoomToData}>Zoom to data</button>
      </div>

      <div className="group">
        <label htmlFor="crs">CRS</label>
        <select id="crs" value={props.crs} onChange={(e) => props.onCrs(e.target.value)}>
          {defaultRegistry
            .list()
            .filter((d) => d.units === 'm')
            .map((d) => (
              <option key={d.code} value={d.code}>
                {d.code} — {d.name}
              </option>
            ))}
        </select>
      </div>

      <label className="checkbox">
        <input type="checkbox" checked={props.basemap} onChange={(e) => props.onBasemap(e.target.checked)} />
        Basemap
      </label>
    </header>
  );
}
