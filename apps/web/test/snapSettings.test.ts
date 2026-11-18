// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { DEFAULT_SNAP_MODES } from '../src/map/snapping.ts';
import { SNAP_SETTINGS_KEY, loadSnapModes, parseSnapModes, saveSnapModes, serializeSnapModes } from '../src/snapSettings.ts';

const sorted = (s: Set<string>) => [...s].sort();

describe('snap settings (snapping spec §7)', () => {
  it('missing or unreadable → defaults', () => {
    for (const raw of [null, undefined, '', 'nope', '{"a":1}', '42']) {
      expect(sorted(parseSnapModes(raw))).toEqual(sorted(new Set(DEFAULT_SNAP_MODES)));
    }
  });

  it('drops unknown entries and keeps known ones', () => {
    expect(sorted(parseSnapModes('["nearest","bogus",3,"centre"]'))).toEqual(['centre', 'nearest']);
  });

  it('"Clear all" (empty list) is remembered as empty, not reset to defaults', () => {
    expect(parseSnapModes('[]').size).toBe(0);
  });

  it('round-trips and serializes in priority order', () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveSnapModes(storage, new Set(['nearest', 'endpoint'] as const));
    expect(m.get(SNAP_SETTINGS_KEY)).toBe('["endpoint","nearest"]');
    expect(sorted(loadSnapModes(storage))).toEqual(['endpoint', 'nearest']);
    expect(serializeSnapModes(new Set(['perpendicular', 'midpoint'] as const))).toBe('["midpoint","perpendicular"]');
  });

  it('survives storage that throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(sorted(loadSnapModes(bad))).toEqual(sorted(new Set(DEFAULT_SNAP_MODES)));
    expect(() => saveSnapModes(bad, new Set())).not.toThrow();
  });
});
