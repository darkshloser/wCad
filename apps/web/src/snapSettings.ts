// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Ticked snap modes, remembered per browser (knowledge/snapping-spec.md §7).
 *
 * Same defensive approach as the view settings: whatever is stored may come from an older version
 * or a hand edit, so unknown entries are dropped and anything unreadable falls back to the
 * defaults. An empty list is valid — it is what "Clear all" saves.
 */

import { DEFAULT_SNAP_MODES, SNAP_MODES, type SnapMode } from './map/snapping.ts';
import type { SettingsStorage } from './viewSettings.ts';

export const SNAP_SETTINGS_KEY = 'wcad.snapModes.v1';

export function parseSnapModes(raw: string | null | undefined): Set<SnapMode> {
  if (!raw) return new Set(DEFAULT_SNAP_MODES);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return new Set(DEFAULT_SNAP_MODES);
  }
  if (!Array.isArray(value)) return new Set(DEFAULT_SNAP_MODES);
  const known = new Set<string>(SNAP_MODES);
  return new Set(value.filter((m): m is SnapMode => typeof m === 'string' && known.has(m)));
}

/** Serialized in priority order, so the stored value is stable regardless of toggle order. */
export function serializeSnapModes(modes: ReadonlySet<SnapMode>): string {
  return JSON.stringify(SNAP_MODES.filter((m) => modes.has(m)));
}

export function loadSnapModes(storage: SettingsStorage | undefined): Set<SnapMode> {
  try {
    return parseSnapModes(storage?.getItem(SNAP_SETTINGS_KEY));
  } catch {
    return new Set(DEFAULT_SNAP_MODES);
  }
}

export function saveSnapModes(storage: SettingsStorage | undefined, modes: ReadonlySet<SnapMode>): void {
  try {
    storage?.setItem(SNAP_SETTINGS_KEY, serializeSnapModes(modes));
  } catch {
    // Storage disabled or full: the choice still applies for this session.
  }
}
