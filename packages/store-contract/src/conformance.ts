// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import type { Change, GeometryStore, NewElement, StoreFactory } from './GeometryStore.ts';

/**
 * The conformance suite (guardrail G3).
 *
 * Every GeometryStore implementation must pass this suite unmodified. It is deliberately
 * runner-agnostic — a plain list of async cases that throw on failure — so it can be executed
 * from Vitest, from node:test, from a browser harness for the SQLite-WASM store, and from CI
 * without three divergent copies.
 *
 * Adding a store implementation without wiring it into this suite fails CI.
 */

export interface ConformanceCase {
  readonly name: string;
  run(store: GeometryStore): Promise<void>;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Conformance failure: ${msg}`);
}

function assertExact(actual: number, expected: number, what: string): void {
  // Object.is, not approximate comparison. Precision is a correctness property here.
  assert(
    Object.is(actual, expected),
    `${what}: expected bit-exact ${expected} (${expected.toExponential(20)}) but got ${actual} (${actual.toExponential(20)})`,
  );
}

const PROJECT = 'proj_conformance';

function line(coords: number[][], layerId = 'L0'): NewElement {
  return { projectId: PROJECT, layerId, kind: 'polyline', crs: 'EPSG:32635', coords };
}

/**
 * Coordinates chosen to be hostile: full 17-significant-digit float64 values at realistic
 * projected magnitudes, where any accidental rounding, string round-trip or float32 truncation
 * shows up immediately.
 */
export const PRECISION_COORDS: number[][] = [
  [500123.45678901234, 4650321.104567891, 12.345678901234567],
  [500123.45678901240, 4650321.104567892, 12.345678901234569],
  [0.1 + 0.2, 1e-15, -0.30000000000000004],
  [Number.MAX_SAFE_INTEGER / 1e3, -4650321.987654321, 1e-300],
];

export const conformanceCases: readonly ConformanceCase[] = [
  {
    name: 'create assigns an id and version 1',
    async run(store) {
      const r = await store.commit(PROJECT, [{ op: 'create', element: line([[0, 0], [10, 10]]) }]);
      assert(r.ok, 'commit should succeed');
      assert(r.ids.length === 1 && r.ids[0]!.length > 0, 'an id should be assigned');
      assert(r.versions[0] === 1, `first version should be 1, got ${r.versions[0]}`);
    },
  },
  {
    name: 'coordinates round-trip bit-exactly (G2)',
    async run(store) {
      const r = await store.commit(PROJECT, [
        { op: 'create', element: line(PRECISION_COORDS.map((c) => [...c])) },
      ]);
      assert(r.ok, 'commit should succeed');
      const [read] = await store.getExact([r.ids[0]!]);
      assert(read, 'element should be readable back');
      for (let i = 0; i < PRECISION_COORDS.length; i++) {
        for (let j = 0; j < PRECISION_COORDS[i]!.length; j++) {
          assertExact(read!.coords[i]![j]!, PRECISION_COORDS[i]![j]!, `coord[${i}][${j}]`);
        }
      }
    },
  },
  {
    name: 'getExact returns nothing for unknown ids rather than throwing',
    async run(store) {
      const res = await store.getExact(['does_not_exist']);
      assert(res.length === 0, 'unknown id should yield no records');
    },
  },
  {
    name: 'queryBBox returns intersecting elements only',
    async run(store) {
      const a = await store.commit(PROJECT, [{ op: 'create', element: line([[0, 0], [1, 1]]) }]);
      const b = await store.commit(PROJECT, [{ op: 'create', element: line([[100, 100], [101, 101]]) }]);
      assert(a.ok && b.ok, 'setup commits should succeed');
      const hits = await store.queryBBox(PROJECT, [-1, -1, 2, 2]);
      const ids = hits.map((h) => h.id);
      assert(ids.includes(a.ids[0]!), 'element inside the bbox should be returned');
      assert(!ids.includes(b.ids[0]!), 'element outside the bbox should not be returned');
    },
  },
  {
    name: 'queryBBox filters by layer',
    async run(store) {
      const a = await store.commit(PROJECT, [{ op: 'create', element: line([[0, 0], [1, 1]], 'LAYER_A') }]);
      const b = await store.commit(PROJECT, [{ op: 'create', element: line([[0, 0], [1, 1]], 'LAYER_B') }]);
      assert(a.ok && b.ok, 'setup commits should succeed');
      const hits = await store.queryBBox(PROJECT, [-1, -1, 2, 2], { layerIds: ['LAYER_A'] });
      const ids = hits.map((h) => h.id);
      assert(ids.includes(a.ids[0]!), 'layer A element should be returned');
      assert(!ids.includes(b.ids[0]!), 'layer B element should be filtered out');
    },
  },
  {
    name: 'queryBBox does not leak across projects',
    async run(store) {
      const mine = await store.commit(PROJECT, [{ op: 'create', element: line([[5, 5], [6, 6]]) }]);
      const other = await store.commit('other_project', [
        { op: 'create', element: { ...line([[5, 5], [6, 6]]), projectId: 'other_project' } },
      ]);
      assert(mine.ok && other.ok, 'setup commits should succeed');
      const hits = await store.queryBBox(PROJECT, [0, 0, 10, 10]);
      assert(!hits.some((h) => h.id === other.ids[0]!), 'other project data must not appear');
    },
  },
  {
    name: 'snapCandidates returns exact stored coordinates, not approximations',
    async run(store) {
      const exact = 4650321.104567891;
      const r = await store.commit(PROJECT, [
        { op: 'create', element: line([[500123.45678901234, exact], [500223.5, exact + 100]]) },
      ]);
      assert(r.ok, 'commit should succeed');
      const cands = await store.snapCandidates(PROJECT, [500123, 4650321, 500124, 4650322], 10);
      const hit = cands.find((c) => c.elementId === r.ids[0]!);
      assert(hit, 'the vertex should be offered as a snap candidate');
      assertExact(hit!.y, exact, 'snap candidate y');
      assertExact(hit!.x, 500123.45678901234, 'snap candidate x');
    },
  },
  {
    name: 'snapCandidates respects the limit and is deterministic',
    async run(store) {
      const coords: number[][] = [];
      for (let i = 0; i < 50; i++) coords.push([i * 0.01, i * 0.01]);
      const r = await store.commit(PROJECT, [{ op: 'create', element: line(coords) }]);
      assert(r.ok, 'commit should succeed');
      const first = await store.snapCandidates(PROJECT, [-1, -1, 1, 1], 5);
      const second = await store.snapCandidates(PROJECT, [-1, -1, 1, 1], 5);
      assert(first.length <= 5, `limit should be respected, got ${first.length}`);
      assert(
        JSON.stringify(first) === JSON.stringify(second),
        'repeated identical queries must return identical, deterministically ordered results',
      );
    },
  },
  {
    name: 'update bumps the version',
    async run(store) {
      const c = await store.commit(PROJECT, [{ op: 'create', element: line([[0, 0], [1, 1]]) }]);
      assert(c.ok, 'create should succeed');
      const u = await store.commit(PROJECT, [
        { op: 'update', id: c.ids[0]!, baseVersion: 1, element: { coords: [[0, 0], [2, 2]] } },
      ]);
      assert(u.ok, 'update should succeed');
      assert(u.versions[0] === 2, `version should become 2, got ${u.versions[0]}`);
    },
  },
  {
    name: 'stale update is rejected with a conflict and leaves data untouched',
    async run(store) {
      const c = await store.commit(PROJECT, [{ op: 'create', element: line([[0, 0], [1, 1]]) }]);
      assert(c.ok, 'create should succeed');
      const id = c.ids[0]!;
      const first = await store.commit(PROJECT, [
        { op: 'update', id, baseVersion: 1, element: { coords: [[0, 0], [2, 2]] } },
      ]);
      assert(first.ok, 'first update should succeed');

      const stale = await store.commit(PROJECT, [
        { op: 'update', id, baseVersion: 1, element: { coords: [[0, 0], [9, 9]] } },
      ]);
      assert(!stale.ok, 'stale update must be rejected');
      assert(stale.conflicts[0]?.id === id, 'conflict should identify the element');
      assert(stale.conflicts[0]?.expectedVersion === 1, 'conflict should report the expected version');
      assert(stale.conflicts[0]?.actualVersion === 2, 'conflict should report the actual version');

      const [after] = await store.getExact([id]);
      assertExact(after!.coords[1]![0]!, 2, 'the first writer data must survive');
    },
  },
  {
    name: 'a commit is atomic: one conflict rolls back the whole batch',
    async run(store) {
      const c = await store.commit(PROJECT, [{ op: 'create', element: line([[0, 0], [1, 1]]) }]);
      assert(c.ok, 'create should succeed');
      const before = await store.count(PROJECT);

      const mixed: Change[] = [
        { op: 'create', element: line([[7, 7], [8, 8]]) },
        { op: 'update', id: c.ids[0]!, baseVersion: 99, element: { coords: [[0, 0], [3, 3]] } },
      ];
      const res = await store.commit(PROJECT, mixed);
      assert(!res.ok, 'the batch must fail');
      const after = await store.count(PROJECT);
      assert(after === before, `no element should have been created; count went ${before} -> ${after}`);
    },
  },
  {
    name: 'delete removes the element and is version-checked',
    async run(store) {
      const c = await store.commit(PROJECT, [{ op: 'create', element: line([[0, 0], [1, 1]]) }]);
      assert(c.ok, 'create should succeed');
      const id = c.ids[0]!;
      const bad = await store.commit(PROJECT, [{ op: 'delete', id, baseVersion: 42 }]);
      assert(!bad.ok, 'delete with a stale version must be rejected');
      const good = await store.commit(PROJECT, [{ op: 'delete', id, baseVersion: 1 }]);
      assert(good.ok, 'delete with the correct version must succeed');
      assert((await store.getExact([id])).length === 0, 'element should be gone');
    },
  },
  {
    name: 'metadata round-trips arbitrary nested JSON unchanged',
    async run(store) {
      const metadata = {
        material: 'steel',
        installDate: '2025-03-01',
        nested: { deep: { deeper: [1, 2, { three: true }] } },
        unicode: 'Кадастър — 地籍 — ✓',
        emptyObj: {},
        emptyArr: [],
        nullValue: null,
        negZero: 0,
        big: 12345678901234.5,
      };
      const r = await store.commit(PROJECT, [
        { op: 'create', element: { ...line([[0, 0], [1, 1]]), metadata } },
      ]);
      assert(r.ok, 'commit should succeed');
      const back = await store.getMetadata(r.ids[0]!);
      assert(
        JSON.stringify(back) === JSON.stringify(metadata),
        `metadata must round-trip unchanged; got ${JSON.stringify(back)}`,
      );
    },
  },
  {
    name: 'metadata is absent from render-path query results',
    async run(store) {
      const r = await store.commit(PROJECT, [
        { op: 'create', element: { ...line([[3, 3], [4, 4]]), metadata: { huge: 'x'.repeat(10_000) } } },
      ]);
      assert(r.ok, 'commit should succeed');
      const hits = await store.snapCandidates(PROJECT, [2, 2, 5, 5], 10);
      const serialized = JSON.stringify(hits);
      assert(
        !serialized.includes('xxxxxxxxxx'),
        'snap candidates must not carry metadata — it would dominate bandwidth at scale',
      );
    },
  },
  {
    name: 'arc parameters survive as a canonical definition',
    async run(store) {
      const params = { cx: 100.5, cy: 200.25, r: 50.125, startAngle: 0.5, endAngle: 2.25, ccw: 1 };
      const r = await store.commit(PROJECT, [
        {
          op: 'create',
          element: { projectId: PROJECT, layerId: 'L0', kind: 'arc', crs: 'EPSG:32635', coords: [[143.4, 224.2], [78.2, 245.1]], params },
        },
      ]);
      assert(r.ok, 'commit should succeed');
      const [back] = await store.getExact([r.ids[0]!]);
      for (const [k, v] of Object.entries(params)) {
        assertExact(back!.params![k]!, v, `arc param ${k}`);
      }
    },
  },
  {
    name: 'count reflects creates and deletes',
    async run(store) {
      const before = await store.count(PROJECT);
      const c = await store.commit(PROJECT, [
        { op: 'create', element: line([[0, 0], [1, 1]]) },
        { op: 'create', element: line([[2, 2], [3, 3]]) },
      ]);
      assert(c.ok, 'creates should succeed');
      assert((await store.count(PROJECT)) === before + 2, 'count should increase by 2');
      await store.commit(PROJECT, [{ op: 'delete', id: c.ids[0]!, baseVersion: 1 }]);
      assert((await store.count(PROJECT)) === before + 1, 'count should decrease by 1');
    },
  },
  {
    name: 'returned records are copies — mutating them does not corrupt the store',
    async run(store) {
      const r = await store.commit(PROJECT, [{ op: 'create', element: line([[1, 1], [2, 2]]) }]);
      assert(r.ok, 'commit should succeed');
      const [rec] = await store.getExact([r.ids[0]!]);
      (rec!.coords[0] as number[])[0] = 999;
      const [again] = await store.getExact([r.ids[0]!]);
      assertExact(again!.coords[0]![0]!, 1, 'store data must be immune to caller mutation');
    },
  },
];

/** Runs every case against a fresh store. Returns failures rather than throwing on the first. */
export async function runConformance(
  factory: StoreFactory,
): Promise<Array<{ name: string; error: Error }>> {
  const failures: Array<{ name: string; error: Error }> = [];
  for (const c of conformanceCases) {
    const store = await factory();
    try {
      await c.run(store);
    } catch (err) {
      failures.push({ name: c.name, error: err as Error });
    } finally {
      await store.close();
    }
  }
  return failures;
}
