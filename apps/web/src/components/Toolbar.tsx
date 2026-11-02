// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { defaultRegistry } from '@wcad/geo-core';
import type { ReactNode } from 'react';
import type { ToolName } from '../map/engine.ts';

const TOOLS: Array<{ id: ToolName; label: string; hint: string; icon?: ReactNode }> = [
  { id: 'pan', label: 'Pan', hint: 'Drag to move the map, wheel to zoom (default tool).', icon: <HandIcon /> },
  {
    id: 'select',
    label: 'Select',
    hint: 'Click or drag a rectangle to select (read-only). Left→right: fully inside; right→left: touching. Shift adds, Ctrl removes.',
  },
  { id: 'point', label: 'Point', hint: 'Click to place points. Esc returns to Select.' },
  { id: 'line', label: 'Polyline', hint: 'Click vertices; double-click, Enter or right-click finishes. Backspace undoes a vertex.' },
  { id: 'polygon', label: 'Polygon', hint: 'Click at least 3 vertices; click the first vertex, double-click or Enter closes.' },
  { id: 'circle', label: 'Circle', hint: 'Click the centre, then a point on the circle.' },
  { id: 'arc3', label: 'Arc (3 pt)', hint: 'Click start, a point on the arc, then end. A preview follows the cursor.' },
];

/** Open-hand icon, inline so the toolbar needs no icon font or extra request. */
function HandIcon() {
  return (
    <svg
      className="tool-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

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
            {t.icon}
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
