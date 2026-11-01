// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT, conformanceCases } from '../src/conformance.ts';
import { MemoryStore } from '../src/memoryStore.ts';
import { computeBBox } from '../src/memoryStore.ts';

/**
 * The reference store must pass the conformance suite (guardrail G3).
 * The PostGIS and SQLite-WASM stores will be wired into this exact suite unchanged.
 */
describe('MemoryStore conformance', () => {
  for (const c of conformanceCases) {
    it(c.name, async () => {
      const store = await MemoryStore.create();
      try {
        await c.run(store, DEFAULT_CONTEXT);
      } finally {
        await store.close();
      }
    });
  }
});

describe('computeBBox', () => {
  it('bounds a polyline', () => {
    expect(computeBBox([[0, 0], [10, -5], [3, 8]])).toEqual([0, -5, 10, 8]);
  });

  it('expands to the full circle envelope for parametric elements', () => {
    expect(computeBBox([[10, 0]], { cx: 0, cy: 0, r: 10 })).toEqual([-10, -10, 10, 10]);
  });

  it('throws for an element with no coordinates', () => {
    expect(() => computeBBox([])).toThrow(/no coordinates/);
  });
});
