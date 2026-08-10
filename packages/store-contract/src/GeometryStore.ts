// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import type { BBox, ElementKind } from '@wcad/geo-core';

/**
 * The single storage contract (architecture doc section 7, principle P4).
 *
 * Two implementations exist: PostGIS on the server and SQLite-WASM/OPFS in the browser. Both
 * must pass the identical conformance suite, which is what makes "huge local file" and "huge
 * server project" one feature rather than two products.
 */

export interface ElementRecord {
  readonly id: string;
  readonly projectId: string;
  readonly layerId: string;
  readonly kind: ElementKind;
  readonly crs: string;
  /** Authoritative float64 coordinates. Stored and returned bit-exactly (guardrail G2). */
  readonly coords: ReadonlyArray<readonly number[]>;
  /** Canonical parametric definition for arcs and circles. */
  readonly params?: Readonly<Record<string, number>> | undefined;
  /** Free-form JSON metadata. Fetched lazily, never on the render path. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly version: number;
  readonly bbox: BBox;
}

export type NewElement = Omit<ElementRecord, 'id' | 'version' | 'bbox'> & {
  readonly id?: string;
};

export interface SnapVertex {
  readonly elementId: string;
  readonly x: number;
  readonly y: number;
  readonly z?: number | undefined;
  readonly role: 'endpoint' | 'vertex' | 'center' | 'midpoint';
}

export type Change =
  | { readonly op: 'create'; readonly element: NewElement }
  | { readonly op: 'update'; readonly id: string; readonly baseVersion: number; readonly element: Partial<NewElement> }
  | { readonly op: 'delete'; readonly id: string; readonly baseVersion: number };

export interface Conflict {
  readonly id: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}

export type CommitResult =
  | { readonly ok: true; readonly ids: readonly string[]; readonly versions: readonly number[] }
  | { readonly ok: false; readonly conflicts: readonly Conflict[] };

export interface QueryOptions {
  readonly layerIds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface GeometryStore {
  readonly name: string;

  /** Authoritative geometry by id. Full float64 — the only source valid for editing. */
  getExact(ids: readonly string[]): Promise<ElementRecord[]>;

  /** Authoritative geometry intersecting a bbox, for populating the working set. */
  queryBBox(projectId: string, bbox: BBox, opts?: QueryOptions): Promise<ElementRecord[]>;

  /** Bounded, proximity-ordered exact vertices for snapping (architecture doc section 6.2). */
  snapCandidates(projectId: string, bbox: BBox, limit: number): Promise<SnapVertex[]>;

  /** Metadata only, fetched lazily when the properties panel opens. */
  getMetadata(id: string): Promise<Readonly<Record<string, unknown>> | undefined>;

  /** Atomic, optimistic-concurrency commit of one user action. */
  commit(projectId: string, changes: readonly Change[]): Promise<CommitResult>;

  /** Number of live elements — used by import reconciliation. */
  count(projectId: string): Promise<number>;

  close(): Promise<void>;
}

export type StoreFactory = () => Promise<GeometryStore>;
