// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import type { BBox } from '@wcad/geo-core';
import type {
  Change,
  CommitResult,
  Conflict,
  ElementRecord,
  GeometryStore,
  NewElement,
  QueryOptions,
  SnapVertex,
} from './GeometryStore.ts';

/**
 * In-memory reference implementation of GeometryStore.
 *
 * Its job is to define correct behaviour precisely enough that the conformance suite itself can
 * be trusted before PostGIS or SQLite-WASM implementations exist. It is also what the demo app
 * runs on, and what unit tests elsewhere use instead of mocks.
 *
 * Coordinates are deep-copied but never rounded, normalized or reformatted, so float64 values
 * round-trip bit-exactly (guardrail G2).
 */
export class MemoryStore implements GeometryStore {
  readonly name = 'memory';
  readonly #elements = new Map<string, ElementRecord>();
  #nextId = 1;

  static async create(): Promise<MemoryStore> {
    return new MemoryStore();
  }

  #id(): string {
    return `el_${this.#nextId++}`;
  }

  async getExact(ids: readonly string[]): Promise<ElementRecord[]> {
    const out: ElementRecord[] = [];
    for (const id of ids) {
      const e = this.#elements.get(id);
      if (e) out.push(clone(e));
    }
    return out;
  }

  async queryBBox(projectId: string, bbox: BBox, opts: QueryOptions = {}): Promise<ElementRecord[]> {
    const layers = opts.layerIds ? new Set(opts.layerIds) : null;
    const out: ElementRecord[] = [];
    for (const e of this.#elements.values()) {
      if (e.projectId !== projectId) continue;
      if (layers && !layers.has(e.layerId)) continue;
      if (!bboxIntersects(e.bbox, bbox)) continue;
      out.push(clone(e));
      if (opts.limit !== undefined && out.length >= opts.limit) break;
    }
    return out;
  }

  async snapCandidates(projectId: string, bbox: BBox, limit: number): Promise<SnapVertex[]> {
    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    const found: Array<{ v: SnapVertex; d: number }> = [];

    for (const e of this.#elements.values()) {
      if (e.projectId !== projectId) continue;
      if (!bboxIntersects(e.bbox, bbox)) continue;

      const push = (x: number, y: number, z: number | undefined, role: SnapVertex['role']) => {
        if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) return;
        found.push({
          v: { elementId: e.id, x, y, z, role },
          d: Math.hypot(x - cx, y - cy),
        });
      };

      for (let i = 0; i < e.coords.length; i++) {
        const c = e.coords[i]!;
        const role: SnapVertex['role'] =
          i === 0 || i === e.coords.length - 1 ? 'endpoint' : 'vertex';
        push(c[0]!, c[1]!, c[2], role);
      }
      if (e.params && typeof e.params['cx'] === 'number' && typeof e.params['cy'] === 'number') {
        push(e.params['cx'], e.params['cy'], undefined, 'center');
      }
    }

    // Deterministic ordering: nearest first, ties broken by element id then role, so results
    // are stable across runs (the conformance suite asserts this).
    found.sort((a, b) => a.d - b.d || a.v.elementId.localeCompare(b.v.elementId) || a.v.role.localeCompare(b.v.role));
    return found.slice(0, limit).map((f) => f.v);
  }

  async getMetadata(id: string): Promise<Readonly<Record<string, unknown>> | undefined> {
    const e = this.#elements.get(id);
    if (!e?.metadata) return undefined;
    return structuredClone(e.metadata) as Record<string, unknown>;
  }

  async commit(projectId: string, changes: readonly Change[]): Promise<CommitResult> {
    // Validate everything before mutating anything: a commit is atomic.
    const conflicts: Conflict[] = [];
    for (const ch of changes) {
      if (ch.op === 'create') continue;
      const existing = this.#elements.get(ch.id);
      if (!existing) {
        conflicts.push({ id: ch.id, expectedVersion: ch.baseVersion, actualVersion: 0 });
      } else if (existing.version !== ch.baseVersion) {
        conflicts.push({ id: ch.id, expectedVersion: ch.baseVersion, actualVersion: existing.version });
      }
    }
    if (conflicts.length > 0) return { ok: false, conflicts };

    const ids: string[] = [];
    const versions: number[] = [];
    for (const ch of changes) {
      if (ch.op === 'create') {
        const id = ch.element.id ?? this.#id();
        const rec: ElementRecord = {
          ...stripUndefined(ch.element),
          id,
          projectId,
          version: 1,
          bbox: computeBBox(ch.element.coords, ch.element.params),
        } as ElementRecord;
        this.#elements.set(id, clone(rec));
        ids.push(id);
        versions.push(1);
      } else if (ch.op === 'update') {
        const prev = this.#elements.get(ch.id)!;
        const merged: ElementRecord = {
          ...prev,
          ...stripUndefined(ch.element),
          id: prev.id,
          projectId: prev.projectId,
          version: prev.version + 1,
        } as ElementRecord;
        const withBBox: ElementRecord = {
          ...merged,
          bbox: computeBBox(merged.coords, merged.params),
        };
        this.#elements.set(ch.id, clone(withBBox));
        ids.push(ch.id);
        versions.push(withBBox.version);
      } else {
        this.#elements.delete(ch.id);
        ids.push(ch.id);
        versions.push(0);
      }
    }
    return { ok: true, ids, versions };
  }

  async count(projectId: string): Promise<number> {
    let n = 0;
    for (const e of this.#elements.values()) if (e.projectId === projectId) n++;
    return n;
  }

  async close(): Promise<void> {
    this.#elements.clear();
  }
}

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Deep copy that preserves float64 values exactly (no serialization round trip). */
function clone(e: ElementRecord): ElementRecord {
  return {
    ...e,
    coords: e.coords.map((c) => [...c]),
    params: e.params ? { ...e.params } : undefined,
    metadata: e.metadata ? (structuredClone(e.metadata) as Record<string, unknown>) : undefined,
    bbox: [...e.bbox] as unknown as BBox,
  };
}

function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

export function computeBBox(
  coords: ReadonlyArray<readonly number[]>,
  params?: Readonly<Record<string, number>> | undefined,
): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of coords) {
    const x = c[0]!;
    const y = c[1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  // Circles and arcs extend beyond their stored endpoints; include the full circle envelope,
  // which is conservative but never wrong (a tight arc bbox is available via arcBBox).
  if (params && typeof params['cx'] === 'number' && typeof params['cy'] === 'number' && typeof params['r'] === 'number') {
    minX = Math.min(minX, params['cx'] - params['r']);
    minY = Math.min(minY, params['cy'] - params['r']);
    maxX = Math.max(maxX, params['cx'] + params['r']);
    maxY = Math.max(maxY, params['cy'] + params['r']);
  }
  if (!Number.isFinite(minX)) throw new Error('computeBBox: element has no coordinates');
  return [minX, minY, maxX, maxY];
}
