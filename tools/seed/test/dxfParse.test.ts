// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  MAX_BIND_PARAMS,
  MAX_ROWS_PER_STATEMENT,
  PARAMS_PER_ROW,
  type ParsedEntity,
  bounds,
  buildEntity,
  insertBatch,
  minVertices,
  readEntities,
  toWkt,
} from '../loadFixture.ts';

const fields = (pairs: Array<[number, string]>) => {
  const m = new Map<number, string[]>();
  for (const [code, value] of pairs) {
    const list = m.get(code) ?? [];
    list.push(value);
    m.set(code, list);
  }
  return m;
};

describe('DXF entity parsing', () => {
  it('parses a point with elevation', () => {
    const e = buildEntity('POINT', fields([[8, 'SURVEY'], [10, '500100'], [20, '4650100'], [30, '123.456']]))!;
    expect(e.kind).toBe('point');
    expect(e.layer).toBe('SURVEY');
    expect(e.coords[0]).toEqual([500100, 4650100, 123.456]);
  });

  it('parses a line from its two endpoint groups', () => {
    const e = buildEntity('LINE', fields([[10, '0'], [20, '0'], [11, '10'], [21, '5']]))!;
    expect(e.kind).toBe('line');
    expect(e.coords).toEqual([[0, 0], [10, 5]]);
  });

  it('parses a polyline with many vertices', () => {
    const e = buildEntity(
      'LWPOLYLINE',
      fields([[10, '0'], [20, '0'], [10, '1'], [20, '1'], [10, '2'], [20, '4']]),
    )!;
    expect(e.kind).toBe('polyline');
    expect(e.coords).toHaveLength(3);
  });

  it('keeps the canonical definition for circles and arcs', () => {
    const circle = buildEntity('CIRCLE', fields([[10, '5'], [20, '5'], [40, '2.5']]))!;
    expect(circle.params).toEqual({ cx: 5, cy: 5, r: 2.5 });
    expect(circle.coords.length).toBeGreaterThan(8);

    const arc = buildEntity('ARC', fields([[10, '0'], [20, '0'], [40, '10'], [50, '0'], [51, '90']]))!;
    expect(arc.params!['r']).toBe(10);
    expect(arc.params!['startAngle']).toBeCloseTo(0, 12);
    expect(arc.params!['endAngle']).toBeCloseTo(Math.PI / 2, 12);
  });

  it('rejects degenerate geometry rather than storing it', () => {
    expect(buildEntity('CIRCLE', fields([[10, '0'], [20, '0'], [40, '0']]))).toBeNull();
    expect(buildEntity('ARC', fields([[10, '0'], [20, '0'], [40, '-5'], [50, '0'], [51, '90']]))).toBeNull();
    expect(buildEntity('LWPOLYLINE', fields([[10, '0'], [20, '0']]))).toBeNull();
    expect(buildEntity('POINT', fields([[8, 'X']]))).toBeNull();
  });

  it('ignores entity types it does not support', () => {
    expect(buildEntity('SPLINE', fields([[10, '0'], [20, '0']]))).toBeNull();
  });

  it('defaults the layer when none is given', () => {
    expect(buildEntity('POINT', fields([[10, '1'], [20, '2']]))!.layer).toBe('0');
  });

  it('streams the tiny fixture and finds every supported entity', async () => {
    const found: string[] = [];
    for await (const e of readEntities('fixtures/tiny.dxf')) found.push(e.kind);
    // tiny.dxf contains one of each supported type; INSERT and TEXT parse as points.
    expect(found).toContain('point');
    expect(found).toContain('line');
    expect(found).toContain('circle');
    expect(found).toContain('arc');
    expect(found).toContain('polyline');
    expect(found).toContain('text');
    expect(found).toContain('insert');
  });

  it('reads every entity in the 10k fixture', async () => {
    let n = 0;
    for await (const _ of readEntities('fixtures/small.dxf')) n++;
    // The generator writes 10,000 entities; a handful are degenerate and correctly dropped.
    expect(n).toBeGreaterThan(9_000);
    expect(n).toBeLessThanOrEqual(10_000);
  });
});

describe('WKT emission', () => {
  it('emits the right geometry type per kind', () => {
    expect(toWkt('point', [[1, 2]])).toBe('POINT(1 2)');
    expect(toWkt('polyline', [[0, 0], [1, 1]])).toBe('LINESTRING(0 0, 1 1)');
    expect(toWkt('polygon', [[0, 0], [1, 0], [1, 1]])).toBe('POLYGON((0 0, 1 0, 1 1, 0 0))');
  });

  it('does not double-close an already closed ring', () => {
    expect(toWkt('polygon', [[0, 0], [1, 0], [1, 1], [0, 0]])).toBe('POLYGON((0 0, 1 0, 1 1, 0 0))');
  });

  it('degrades a single-vertex line to a point rather than emitting invalid WKT', () => {
    expect(toWkt('polyline', [[3, 4]])).toBe('POINT(3 4)');
  });
});

describe('helpers', () => {
  it('reports minimum vertex counts per kind', () => {
    expect(minVertices('polygon')).toBe(3);
    expect(minVertices('point')).toBe(1);
    expect(minVertices('polyline')).toBe(2);
  });

  it('computes bounds', () => {
    expect(bounds([[0, 0], [10, -5], [3, 8]])).toEqual([0, -5, 10, 8]);
  });
});

/**
 * PostgreSQL sends the bind parameter count as an int16, so exceeding 65535 wraps silently rather
 * than erroring usefully: a 10,000-row batch (90,000 params) arrived as 24,464 and the server
 * reported "bind message has 24464 parameter formats but 0 parameters". These assertions exist so
 * that adding a column to the INSERT can never quietly reintroduce that.
 */
describe('bind parameter limit', () => {
  it('keeps a full statement within the protocol ceiling', () => {
    expect(MAX_ROWS_PER_STATEMENT * PARAMS_PER_ROW).toBeLessThanOrEqual(MAX_BIND_PARAMS);
  });

  it('packs as many rows as the ceiling allows', () => {
    expect((MAX_ROWS_PER_STATEMENT + 1) * PARAMS_PER_ROW).toBeGreaterThan(MAX_BIND_PARAMS);
  });

  it('stays under the int16 ceiling where the old batch size overflowed', () => {
    // The regression itself: 10_000 * 9 exceeds the limit and wraps.
    expect(10_000 * PARAMS_PER_ROW).toBeGreaterThan(MAX_BIND_PARAMS);
    expect((10_000 * PARAMS_PER_ROW) % 65_536).toBe(24_464);
  });

  it('splits a full batch into statements that each fit, losing no rows', async () => {
    const calls: Array<{ text: string; count: number }> = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, count: values?.length ?? 0 });
        return {};
      },
    };

    const entity: ParsedEntity = { kind: 'polyline', layer: '0', coords: [[0, 0], [1, 1]] };
    const batch = Array.from({ length: 10_000 }, () => ({ entity, layerId: '1' }));
    await insertBatch(pool, '1', 32635, batch);

    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.count).toBeLessThanOrEqual(MAX_BIND_PARAMS);
    }
    // Every row still gets written — chunking must not drop the remainder.
    expect(calls.reduce((n, c) => n + c.count, 0)).toBe(10_000 * PARAMS_PER_ROW);
  });

  it('numbers placeholders from $1 within each statement', async () => {
    const texts: string[] = [];
    const pool = {
      async query(text: string) {
        texts.push(text);
        return {};
      },
    };

    const entity: ParsedEntity = { kind: 'polyline', layer: '0', coords: [[0, 0], [1, 1]] };
    await insertBatch(pool, '1', 32635, Array.from({ length: 10_000 }, () => ({ entity, layerId: '1' })));

    // A second statement that continued numbering from the first would reference parameters it
    // never sends.
    for (const text of texts) {
      expect(text).toContain('($1, $2, $3, $4,');
      // reduce, not Math.max(...spread): a statement carries ~65k placeholders and spreading that
      // many arguments overflows the call stack.
      const highest = [...text.matchAll(/\$(\d+)/g)].reduce((max, m) => Math.max(max, Number(m[1])), 0);
      expect(highest).toBeLessThanOrEqual(MAX_BIND_PARAMS);
    }
  });
});
