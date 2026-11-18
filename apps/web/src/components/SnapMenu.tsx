// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { SNAP_MODES, SNAP_MODE_LABEL, type SnapMode, perpendicularAvailable } from '../map/snapping.ts';
import type { ToolName } from '../map/engine.ts';

/**
 * The Snap toolbar button and its dropdown (knowledge/snapping-spec.md §7).
 *
 * Rows are real checkboxes, so they toggle on click and keyboard alike and the menu stays open.
 * Each icon is the marker the map shows for that mode, so what the user ticks is what they see.
 */
export function SnapMenu(props: {
  tool: ToolName;
  enabled: boolean;
  modes: ReadonlySet<SnapMode>;
  onEnabled: (on: boolean) => void;
  onModes: (modes: Set<SnapMode>) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  // Close on a click outside or Esc (spec §7).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    // Capture phase on window, and stop it there: this Esc only closes the menu. Without that the
    // map also received it, and in a drawing tool Esc means "return to Select".
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const toggle = (mode: SnapMode) => {
    const next = new Set(props.modes);
    if (next.has(mode)) next.delete(mode);
    else next.add(mode);
    props.onModes(next);
  };

  const perpendicularOk = perpendicularAvailable(props.tool);
  const count = SNAP_MODES.filter((m) => props.modes.has(m)).length;

  return (
    <div className="snap-menu" ref={root}>
      <button
        className={`snap-button ${props.enabled ? 'on' : 'off'}`}
        aria-haspopup="true"
        aria-expanded={open}
        title={`Object snap ${props.enabled ? 'on' : 'off'} (F3) — ${count} mode${count === 1 ? '' : 's'} ticked`}
        onClick={() => setOpen((o) => !o)}
      >
        <MarkerIcon mode="endpoint" />
        Snap{props.enabled ? ` (${count})` : ' off'} ▾
      </button>

      {open && (
        <div className="snap-dropdown" role="group" aria-label="Object snap">
          <label className="snap-row master">
            <input type="checkbox" checked={props.enabled} onChange={(e) => props.onEnabled(e.target.checked)} />
            <span className="snap-label">Snapping on</span>
            <kbd>F3</kbd>
          </label>
          <div className="menu-separator" />
          {SNAP_MODES.map((mode) => {
            const unavailable = mode === 'perpendicular' && !perpendicularOk;
            return (
              <label
                key={mode}
                className={`snap-row ${unavailable ? 'unavailable' : ''}`}
                title={unavailable ? 'Only while drawing a polyline or polygon' : undefined}
              >
                <input
                  type="checkbox"
                  aria-label={SNAP_MODE_LABEL[mode]}
                  checked={props.modes.has(mode)}
                  disabled={unavailable}
                  onChange={() => toggle(mode)}
                />
                <MarkerIcon mode={mode} />
                <span className="snap-label">{SNAP_MODE_LABEL[mode]}</span>
              </label>
            );
          })}
          <div className="menu-separator" />
          <div className="snap-actions">
            <button onClick={() => props.onModes(new Set(SNAP_MODES))}>Select all</button>
            <button onClick={() => props.onModes(new Set())}>Clear all</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The map's snap marker for a mode, as a 16 px icon (spec §5). */
function MarkerIcon(props: { mode: SnapMode }): ReactNode {
  const shapes: Record<SnapMode, ReactNode> = {
    endpoint: <rect x="3" y="3" width="10" height="10" />,
    midpoint: <path d="M8 2 L14 13 L2 13 Z" />,
    centre: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      </>
    ),
    intersection: <path d="M3 3 L13 13 M13 3 L3 13" />,
    perpendicular: <path d="M3 2 V13 H14 M3 9 H7 V13" />,
    nearest: <path d="M3 3 H13 L3 13 H13 Z" />,
  };
  return (
    <svg className="snap-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      {shapes[props.mode]}
    </svg>
  );
}
