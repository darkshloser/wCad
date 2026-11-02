// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * View settings from the empty-space menu (knowledge/selection-spec.md §4.1), remembered per
 * browser.
 *
 * Parsing is defensive by design: the stored value is whatever an older version of the app, a
 * browser extension or a user in devtools left behind. Anything unreadable falls back to the
 * default field by field, so one bad value never resets the others and never stops the app.
 */

export type Background = 'dark' | 'light';

export interface ViewSettings {
  readonly basemap: boolean;
  readonly background: Background;
  readonly showPerf: boolean;
}

export const DEFAULT_VIEW_SETTINGS: ViewSettings = Object.freeze({
  basemap: false,
  background: 'dark',
  showPerf: true,
});

/** Versioned so a future incompatible shape can be ignored rather than misread. */
export const VIEW_SETTINGS_KEY = 'wcad.viewSettings.v1';

export function parseViewSettings(raw: string | null | undefined): ViewSettings {
  if (!raw) return DEFAULT_VIEW_SETTINGS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_VIEW_SETTINGS;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_VIEW_SETTINGS;
  const v = value as Record<string, unknown>;
  return {
    basemap: typeof v['basemap'] === 'boolean' ? v['basemap'] : DEFAULT_VIEW_SETTINGS.basemap,
    background: v['background'] === 'light' || v['background'] === 'dark' ? v['background'] : DEFAULT_VIEW_SETTINGS.background,
    showPerf: typeof v['showPerf'] === 'boolean' ? v['showPerf'] : DEFAULT_VIEW_SETTINGS.showPerf,
  };
}

export function serializeViewSettings(s: ViewSettings): string {
  return JSON.stringify({ basemap: s.basemap, background: s.background, showPerf: s.showPerf });
}

/** Minimal storage surface, so tests and private-mode browsers can substitute their own. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads settings. Storage can throw (private mode, disabled cookies); that means "use defaults". */
export function loadViewSettings(storage: SettingsStorage | undefined): ViewSettings {
  try {
    return parseViewSettings(storage?.getItem(VIEW_SETTINGS_KEY));
  } catch {
    return DEFAULT_VIEW_SETTINGS;
  }
}

/** Saves settings. A failure to save must never break the app; the setting still applies now. */
export function saveViewSettings(storage: SettingsStorage | undefined, s: ViewSettings): void {
  try {
    storage?.setItem(VIEW_SETTINGS_KEY, serializeViewSettings(s));
  } catch {
    // Quota exceeded or storage disabled: keep the in-memory setting only.
  }
}
