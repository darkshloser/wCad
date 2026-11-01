// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

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
  run(store: GeometryStore, ctx: ConformanceContext): Promise<void>;
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

/**
 * Structural equality that ignores object key order but preserves array order.
 *
 * Object key order is deliberately not part of the metadata contract. PostgreSQL's jsonb type
 * normalizes objects on write — it sorts keys and drops duplicates — so it physically cannot
 * return them in insertion order, whereas a store that keeps metadata as JSON text would. Demanding
 * key order would therefore make it impossible for both to pass one suite, which is precisely what
 * guardrail G3 requires.
 *
 * Array order, by contrast, IS part of the contract: it carries meaning, and jsonb preserves it.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

/**
 * Identifiers are supplied by the harness, never invented here.
 *
 * Stores disagree about what an identifier *is*: the in-memory reference store treats ids as
 * opaque strings, while the PostGIS store uses bigint primary keys and rejects anything
 * non-numeric. A suite that hardcoded `'proj_conformance'` would therefore be unrunnable against
 * a real database — which defeats the point of guardrail G3, since the suite must run unmodified
 * against every implementation (SQLite-WASM included, in Phase 5).
 *
 * So the harness creates whatever project, layer and element ids are valid for its own store and
 * passes them in. The suite asserts on behaviour; the harness owns identity.
 */
export interface ConformanceContext {
  readonly projectId: string;
  /** A second, distinct project — used to prove queries never leak across project boundaries. */
  readonly otherProjectId: string;
  readonly layers: { readonly l0: string; readonly a: string; readonly b: string };
  /** A well-formed id for this store that is guaranteed not to exist. */
  readonly missingElementId: string;
}

/** Defaults for stores that treat identifiers as opaque strings (e.g. the in-memory store). */
export const DEFAULT_CONTEXT: ConformanceContext = {
  projectId: 'proj_conformance',
  otherProjectId: 'proj_other',
  layers: { l0: 'L0', a: 'LAYER_A', b: 'LAYER_B' },
  missingElementId: 'does_not_exist',
};

function line(ctx: ConformanceContext, coords: number[][], layerId?: string): NewElement {
  return {
    projectId: ctx.projectId,
    layerId: layerId ?? ctx.layers.l0,
    kind: 'polyline',
    crs: 'EPSG:32635',
    coords,
  };
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
    async run(store, ctx) {
      const r = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[0, 0], [10, 10]]) }]);
      assert(r.ok, 'commit should succeed');
      assert(r.ids.length === 1 && r.ids[0]!.length > 0, 'an id should be assigned');
      assert(r.versions[0] === 1, `first version should be 1, got ${r.versions[0]}`);
    },
  },
  {
    name: 'coordinates round-trip bit-exactly (G2)',
    async run(store, ctx) {
      const r = await store.commit(ctx.projectId, [
        { op: 'create', element: line(ctx, PRECISION_COORDS.map((c) => [...c])) },
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
    async run(store, ctx) {
      const res = await store.getExact([ctx.missingElementId]);
      assert(res.length === 0, 'unknown id should yield no records');
    },
  },
  {
    name: 'queryBBox returns intersecting elements only',
    async run(store, ctx) {
      const a = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[0, 0], [1, 1]]) }]);
      const b = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[100, 100], [101, 101]]) }]);
      assert(a.ok && b.ok, 'setup commits should succeed');
      const hits = await store.queryBBox(ctx.projectId, [-1, -1, 2, 2]);
      const ids = hits.map((h) => h.id);
      assert(ids.includes(a.ids[0]!), 'element inside the bbox should be returned');
      assert(!ids.includes(b.ids[0]!), 'element outside the bbox should not be returned');
    },
  },
  {
    name: 'queryBBox filters by layer',
    async run(store, ctx) {
      const a = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[0, 0], [1, 1]], ctx.layers.a) }]);
      const b = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[0, 0], [1, 1]], ctx.layers.b) }]);
      assert(a.ok && b.ok, 'setup commits should succeed');
      const hits = await store.queryBBox(ctx.projectId, [-1, -1, 2, 2], { layerIds: [ctx.layers.a] });
      const ids = hits.map((h) => h.id);
      assert(ids.includes(a.ids[0]!), 'layer A element should be returned');
      assert(!ids.includes(b.ids[0]!), 'layer B element should be filtered out');
    },
  },
  {
    name: 'queryBBox does not leak across projects',
    async run(store, ctx) {
      const mine = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[5, 5], [6, 6]]) }]);
      const other = await store.commit(ctx.otherProjectId, [
        { op: 'create', element: { ...line(ctx, [[5, 5], [6, 6]]), projectId: ctx.otherProjectId } },
      ]);
      assert(mine.ok && other.ok, 'setup commits should succeed');
      const hits = await store.queryBBox(ctx.projectId, [0, 0, 10, 10]);
      assert(!hits.some((h) => h.id === other.ids[0]!), 'other project data must not appear');
    },
  },
  {
    name: 'snapCandidates returns exact stored coordinates, not approximations',
    async run(store, ctx) {
      const exact = 4650321.104567891;
      const r = await store.commit(ctx.projectId, [
        { op: 'create', element: line(ctx, [[500123.45678901234, exact], [500223.5, exact + 100]]) },
      ]);
      assert(r.ok, 'commit should succeed');
      const cands = await store.snapCandidates(ctx.projectId, [500123, 4650321, 500124, 4650322], 10);
      const hit = cands.find((c) => c.elementId === r.ids[0]!);
      assert(hit, 'the vertex should be offered as a snap candidate');
      assertExact(hit!.y, exact, 'snap candidate y');
      assertExact(hit!.x, 500123.45678901234, 'snap candidate x');
    },
  },
  {
    name: 'snapCandidates respects the limit and is deterministic',
    async run(store, ctx) {
      const coords: number[][] = [];
      for (let i = 0; i < 50; i++) coords.push([i * 0.01, i * 0.01]);
      const r = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, coords) }]);
      assert(r.ok, 'commit should succeed');
      const first = await store.snapCandidates(ctx.projectId, [-1, -1, 1, 1], 5);
      const second = await store.snapCandidates(ctx.projectId, [-1, -1, 1, 1], 5);
      assert(first.length <= 5, `limit should be respected, got ${first.length}`);
      assert(
        JSON.stringify(first) === JSON.stringify(second),
        'repeated identical queries must return identical, deterministically ordered results',
      );
    },
  },
  {
    name: 'update bumps the version',
    async run(store, ctx) {
      const c = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[0, 0], [1, 1]]) }]);
      assert(c.ok, 'create should succeed');
      const u = await store.commit(ctx.projectId, [
        { op: 'update', id: c.ids[0]!, baseVersion: 1, element: { coords: [[0, 0], [2, 2]] } },
      ]);
      assert(u.ok, 'update should succeed');
      assert(u.versions[0] === 2, `version should become 2, got ${u.versions[0]}`);
    },
  },
  {
    name: 'stale update is rejected with a conflict and leaves data untouched',
    async run(store, ctx) {
      const c = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[0, 0], [1, 1]]) }]);
      assert(c.ok, 'create should succeed');
      const id = c.ids[0]!;
      const first = await store.commit(ctx.projectId, [
        { op: 'update', id, baseVersion: 1, element: { coords: [[0, 0], [2, 2]] } },
      ]);
      assert(first.ok, 'first update should succeed');

      const stale = await store.commit(ctx.projectId, [
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
    async run(store, ctx) {
      const c = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[0, 0], [1, 1]]) }]);
      assert(c.ok, 'create should succeed');
      const before = await store.count(ctx.projectId);

      const mixed: Change[] = [
        { op: 'create', element: line(ctx, [[7, 7], [8, 8]]) },
        { op: 'update', id: c.ids[0]!, baseVersion: 99, element: { coords: [[0, 0], [3, 3]] } },
      ];
      const res = await store.commit(ctx.projectId, mixed);
      assert(!res.ok, 'the batch must fail');
      const after = await store.count(ctx.projectId);
      assert(after === before, `no element should have been created; count went ${before} -> ${after}`);
    },
  },
  {
    name: 'delete removes the element and is version-checked',
    async run(store, ctx) {
      const c = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[0, 0], [1, 1]]) }]);
      assert(c.ok, 'create should succeed');
      const id = c.ids[0]!;
      const bad = await store.commit(ctx.projectId, [{ op: 'delete', id, baseVersion: 42 }]);
      assert(!bad.ok, 'delete with a stale version must be rejected');
      const good = await store.commit(ctx.projectId, [{ op: 'delete', id, baseVersion: 1 }]);
      assert(good.ok, 'delete with the correct version must succeed');
      assert((await store.getExact([id])).length === 0, 'element should be gone');
    },
  },
  {
    name: 'metadata round-trips arbitrary nested JSON unchanged',
    async run(store, ctx) {
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
      const r = await store.commit(ctx.projectId, [
        { op: 'create', element: { ...line(ctx, [[0, 0], [1, 1]]), metadata } },
      ]);
      assert(r.ok, 'commit should succeed');
      const back = await store.getMetadata(r.ids[0]!);
      // Compared structurally: values and array order must survive, object key order need not.
      // See deepEqual for why key order is outside the contract.
      assert(
        deepEqual(back, metadata),
        `metadata must round-trip unchanged;\n  expected ${JSON.stringify(metadata)}\n  got      ${JSON.stringify(back)}`,
      );
    },
  },
  {
    name: 'metadata is absent from render-path query results',
    async run(store, ctx) {
      const r = await store.commit(ctx.projectId, [
        { op: 'create', element: { ...line(ctx, [[3, 3], [4, 4]]), metadata: { huge: 'x'.repeat(10_000) } } },
      ]);
      assert(r.ok, 'commit should succeed');
      const hits = await store.snapCandidates(ctx.projectId, [2, 2, 5, 5], 10);
      const serialized = JSON.stringify(hits);
      assert(
        !serialized.includes('xxxxxxxxxx'),
        'snap candidates must not carry metadata — it would dominate bandwidth at scale',
      );
    },
  },
  {
    name: 'arc parameters survive as a canonical definition',
    async run(store, ctx) {
      const params = { cx: 100.5, cy: 200.25, r: 50.125, startAngle: 0.5, endAngle: 2.25, ccw: 1 };
      const r = await store.commit(ctx.projectId, [
        {
          op: 'create',
          element: {
            projectId: ctx.projectId,
            layerId: ctx.layers.l0,
            kind: 'arc',
            crs: 'EPSG:32635',
            coords: [[143.4, 224.2], [78.2, 245.1]],
            params,
          },
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
    async run(store, ctx) {
      const before = await store.count(ctx.projectId);
      const c = await store.commit(ctx.projectId, [
        { op: 'create', element: line(ctx, [[0, 0], [1, 1]]) },
        { op: 'create', element: line(ctx, [[2, 2], [3, 3]]) },
      ]);
      assert(c.ok, 'creates should succeed');
      assert((await store.count(ctx.projectId)) === before + 2, 'count should increase by 2');
      await store.commit(ctx.projectId, [{ op: 'delete', id: c.ids[0]!, baseVersion: 1 }]);
      assert((await store.count(ctx.projectId)) === before + 1, 'count should decrease by 1');
    },
  },
  {
    name: 'returned records are copies — mutating them does not corrupt the store',
    async run(store, ctx) {
      const r = await store.commit(ctx.projectId, [{ op: 'create', element: line(ctx, [[1, 1], [2, 2]]) }]);
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
  ctx: ConformanceContext = DEFAULT_CONTEXT,
): Promise<Array<{ name: string; error: Error }>> {
  const failures: Array<{ name: string; error: Error }> = [];
  for (const c of conformanceCases) {
    const store = await factory();
    try {
      await c.run(store, ctx);
    } catch (err) {
      failures.push({ name: c.name, error: err as Error });
    } finally {
      await store.close();
    }
  }
  return failures;
}
