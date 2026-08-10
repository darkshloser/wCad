// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import type { BBox, ElementKind } from '../types.ts';

/**
 * The backdrop / working-set split (architecture doc section 3, principle P1 and P2).
 *
 * The distinction is expressed in the type system rather than left to discipline: a backdrop
 * feature carries no authoritative coordinates at all, so there is nothing for editing code to
 * accidentally consume. dependency-cruiser additionally forbids editing modules from importing
 * tile code (guardrail G1).
 */

/** A feature decoded from a tile: generalized, quantized, display-only. Never editable. */
export interface BackdropFeature {
  readonly source: 'backdrop';
  readonly id: string;
  readonly kind: ElementKind;
  readonly layerId: string;
  /** Quantized tile coordinates. Approximate by construction — see the MVT specification. */
  readonly displayCoords: ReadonlyArray<readonly [number, number]>;
}

/** A feature loaded from the exact-geometry API: authoritative float64, editable. */
export interface WorkingSetFeature {
  readonly source: 'working-set';
  readonly id: string;
  readonly kind: ElementKind;
  readonly layerId: string;
  readonly crs: string;
  /** Authoritative float64 coordinates. The only coordinates that may be edited or snapped to. */
  readonly coords: ReadonlyArray<readonly [number, number] | readonly [number, number, number]>;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly version: number;
}

export type AnyFeature = BackdropFeature | WorkingSetFeature;

export function isEditable(f: AnyFeature): f is WorkingSetFeature {
  return f.source === 'working-set';
}

/**
 * Guard used at the boundary of every editing operation. Throwing here converts a class of
 * silent precision bugs into a loud, immediate failure.
 */
export function requireEditable(f: AnyFeature): WorkingSetFeature {
  if (!isEditable(f)) {
    throw new Error(
      `Refusing to edit feature ${f.id}: it came from the backdrop (tiled, generalized, quantized). ` +
        `Promote it into the working set with the exact-geometry API first.`,
    );
  }
  return f;
}

export interface ViewportRequest {
  readonly bbox: BBox;
  readonly zoom: number;
  readonly layerIds?: readonly string[];
}
