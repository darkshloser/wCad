// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW_SETTINGS,
  VIEW_SETTINGS_KEY,
  loadViewSettings,
  parseViewSettings,
  saveViewSettings,
  serializeViewSettings,
} from '../src/viewSettings.ts';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('view settings (selection spec §4.1)', () => {
  it('defaults: dark background, basemap off, performance readout on', () => {
    expect(DEFAULT_VIEW_SETTINGS).toEqual({ basemap: false, background: 'dark', showPerf: true });
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const s = { basemap: true, background: 'light', showPerf: false } as const;
    saveViewSettings(storage, s);
    expect(loadViewSettings(storage)).toEqual(s);
    expect(storage.m.has(VIEW_SETTINGS_KEY)).toBe(true);
  });

  it('falls back to defaults for missing or unreadable values', () => {
    expect(parseViewSettings(null)).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(parseViewSettings('not json')).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(parseViewSettings('[1,2]')).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(parseViewSettings('null')).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  it('repairs a bad field without resetting the good ones', () => {
    expect(parseViewSettings('{"basemap":true,"background":"purple","showPerf":"yes"}')).toEqual({
      basemap: true,
      background: 'dark',
      showPerf: true,
    });
  });

  it('survives storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadViewSettings(throwing)).toEqual(DEFAULT_VIEW_SETTINGS);
    expect(() => saveViewSettings(throwing, DEFAULT_VIEW_SETTINGS)).not.toThrow();
    expect(loadViewSettings(undefined)).toEqual(DEFAULT_VIEW_SETTINGS);
  });

  it('serializes only known fields', () => {
    const extra = { ...DEFAULT_VIEW_SETTINGS, secret: 1 } as never;
    expect(JSON.parse(serializeViewSettings(extra))).toEqual(DEFAULT_VIEW_SETTINGS);
  });
});
