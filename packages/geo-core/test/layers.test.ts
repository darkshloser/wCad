// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

import { describe, expect, it } from 'vitest';
import { type BackdropFeature, type WorkingSetFeature, isEditable, requireEditable } from '../src/layers/sources.ts';

const backdrop: BackdropFeature = {
  source: 'backdrop',
  id: 'b1',
  kind: 'polyline',
  layerId: 'L0',
  displayCoords: [[0, 0], [4096, 4096]],
};

const working: WorkingSetFeature = {
  source: 'working-set',
  id: 'w1',
  kind: 'polyline',
  layerId: 'L0',
  crs: 'EPSG:32635',
  coords: [[500123.45678901234, 4650321.104567891]],
  version: 3,
};

describe('backdrop / working-set separation (P1)', () => {
  it('identifies which features may be edited', () => {
    expect(isEditable(backdrop)).toBe(false);
    expect(isEditable(working)).toBe(true);
  });

  it('refuses to edit a backdrop feature with an actionable message', () => {
    expect(() => requireEditable(backdrop)).toThrow(/Promote it into the working set/);
  });

  it('passes working-set features straight through', () => {
    expect(requireEditable(working)).toBe(working);
  });

  it('backdrop features carry no authoritative coordinates at all', () => {
    expect('coords' in backdrop).toBe(false);
  });
});
