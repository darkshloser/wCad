// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import { describe, expect, it } from 'vitest';
import { conformanceCases } from '../src/conformance.ts';
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
        await c.run(store);
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
