// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type RankableElement, bboxArea, compareForTile, rankForTile } from '../src/ranking.ts';

const el = (id: string, size: number, layerPriority = 0): RankableElement => ({
  id,
  bbox: [0, 0, size, size],
  layerPriority,
});

describe('per-tile element ranking', () => {
  it('computes bbox area and clamps inverted boxes to zero', () => {
    expect(bboxArea([0, 0, 10, 5])).toBe(50);
    expect(bboxArea([10, 10, 0, 0])).toBe(0);
  });

  it('sorts by layer priority first', () => {
    const ranked = rankForTile([el('a', 100, 5), el('b', 1, 1)], 10);
    expect(ranked.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('prefers larger elements within a layer', () => {
    const ranked = rankForTile([el('small', 1), el('big', 100)], 10);
    expect(ranked.map((e) => e.id)).toEqual(['big', 'small']);
  });

  it('breaks exact ties by id so the order is total', () => {
    const ranked = rankForTile([el('z', 10), el('a', 10), el('m', 10)], 10);
    expect(ranked.map((e) => e.id)).toEqual(['a', 'm', 'z']);
  });

  it('applies the cap', () => {
    const many = Array.from({ length: 100 }, (_, i) => el(`e${i}`, 100 - i));
    expect(rankForTile(many, 10)).toHaveLength(10);
    expect(rankForTile(many, 0)).toHaveLength(0);
  });

  it('rejects an invalid cap', () => {
    expect(() => rankForTile([], -1)).toThrow(/non-negative/);
    expect(() => rankForTile([], 1.5)).toThrow(/non-negative/);
  });

  it('does not mutate its input', () => {
    const input = [el('b', 1), el('a', 100)];
    const copy = [...input];
    rankForTile(input, 2);
    expect(input).toEqual(copy);
  });

  // Tiles are cached and compared byte-for-byte, so ranking must not depend on input order.
  it('produces identical output regardless of input order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 8 }),
            size: fc.double({ min: 0.1, max: 1000, noNaN: true }),
            layerPriority: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        fc.integer({ min: 1, max: 30 }),
        (specs, limit) => {
          // De-duplicate ids: two elements sharing an id would be genuinely indistinguishable.
          const seen = new Set<string>();
          const elements = specs
            .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
            .map((s) => el(s.id, s.size, s.layerPriority));

          const forward = rankForTile(elements, limit).map((e) => e.id);
          const reversed = rankForTile([...elements].reverse(), limit).map((e) => e.id);
          const shuffled = rankForTile([...elements].sort((a, b) => (a.id > b.id ? -1 : 1)), limit).map((e) => e.id);

          expect(reversed).toEqual(forward);
          expect(shuffled).toEqual(forward);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('defines a consistent total order', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.record({ id: fc.string({ minLength: 1 }), size: fc.double({ min: 1, max: 100, noNaN: true }), p: fc.integer({ min: 0, max: 3 }) }),
          fc.record({ id: fc.string({ minLength: 1 }), size: fc.double({ min: 1, max: 100, noNaN: true }), p: fc.integer({ min: 0, max: 3 }) }),
        ),
        ([a, b]) => {
          const ea = el(a.id, a.size, a.p);
          const eb = el(b.id, b.size, b.p);
          expect(Math.sign(compareForTile(ea, eb))).toBe(-Math.sign(compareForTile(eb, ea)));
        },
      ),
      { numRuns: 300 },
    );
  });
});
