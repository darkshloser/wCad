// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import type { PerfSnapshot } from '../map/instrumentation.ts';

/**
 * The performance readout is deliberately always visible rather than hidden behind a debug flag.
 * The budgets in the architecture document are only meaningful if a regression is obvious while
 * someone is working, not just when a nightly job fails.
 */
export function StatusBar(props: {
  message: string;
  coordinate: string;
  crs: string;
  elementCount: number;
  selectedCount?: number;
  perf?: PerfSnapshot | null;
}) {
  const perf = props.perf;
  const fpsClass = !perf ? '' : perf.fps >= 55 ? 'good' : perf.fps >= 30 ? 'warn' : 'bad';

  return (
    <footer className="status-bar">
      <span className="message">{props.message}</span>
      <span className="spacer" />
      {perf && (
        <>
          <span className={`perf ${fpsClass}`} title="Budget: 60 fps sustained, never below 30">
            {perf.fps.toFixed(0)} fps
          </span>
          {perf.tileLoadCount > 0 && (
            <span className="perf" title="Budget: under 300 ms on a cache miss">
              tile p95 {perf.tileLoadP95Ms.toFixed(0)} ms
            </span>
          )}
          {perf.tileErrorCount > 0 && (
            <span
              className="perf bad"
              title={`Last error: ${perf.lastTileError ?? 'unknown'}\nAll errors are logged in the browser console (F12).`}
            >
              {perf.tileErrorCount} tile errors
            </span>
          )}
          {perf.heapMb !== null && (
            <span className="perf" title="Budget: under 1.5 GB at 10M objects">
              {perf.heapMb.toFixed(0)} MB
            </span>
          )}
        </>
      )}
      <span className="coordinate">{props.coordinate}</span>
      <span className="crs">{props.crs}</span>
      {(props.selectedCount ?? 0) > 0 && <span className="selection">{props.selectedCount} selected</span>}
      <span className="count">{props.elementCount} elements</span>
    </footer>
  );
}
