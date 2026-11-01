// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LOD_TOLERANCES } from '@wcad/geo-core';
import {
  ERROR_BUDGET_PIXELS,
  LOD_COLUMNS,
  bboxDiagonal,
  isTooSmallToDraw,
  minFeatureSize,
  selectLodForResolution,
  selectLodForZoom,
} from '../src/lod.ts';
import { createTileScheme, resolution } from '../src/scheme.ts';

const scheme = createTileScheme('EPSG:32635', [490_000, 4_640_000, 510_000, 4_660_000], { maxZoom: 20 });

describe('LOD selection', () => {
  it('maps level 0 to the authoritative geometry column', () => {
    expect(LOD_COLUMNS[0]).toBe('geom');
    expect(LOD_COLUMNS[1]).toBe('geom_lod1');
    expect(LOD_COLUMNS[3]).toBe('geom_lod3');
  });

  it('uses the exact column when zoomed in far enough to see the difference', () => {
    // At 1 mm per pixel no generalization is acceptable.
    expect(selectLodForResolution(0.001)).toBe(0);
  });

  it('uses the coarsest level when zoomed right out', () => {
    expect(selectLodForResolution(10_000)).toBe(3);
  });

  it('never generalizes beyond the half-pixel error budget', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-4, max: 1e5, noNaN: true }), (res) => {
        const level = selectLodForResolution(res);
        if (level === 0) return;
        const tolerance = LOD_TOLERANCES[level - 1]!;
        expect(tolerance).toBeLessThanOrEqual(res * ERROR_BUDGET_PIXELS);
      }),
      { numRuns: 500 },
    );
  });

  it('is monotone: coarser resolution never selects a finer level', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-3, max: 1e4, noNaN: true }),
        fc.double({ min: 1, max: 1000, noNaN: true }),
        (res, factor) => {
          expect(selectLodForResolution(res * factor)).toBeGreaterThanOrEqual(selectLodForResolution(res));
        },
      ),
      { numRuns: 400 },
    );
  });

  it('is monotone across the zoom pyramid: zooming in never coarsens detail', () => {
    for (let z = 1; z <= scheme.maxZoom; z++) {
      expect(selectLodForZoom(scheme, z)).toBeLessThanOrEqual(selectLodForZoom(scheme, z - 1));
    }
  });

  it('reaches the exact geometry before the maximum zoom', () => {
    expect(selectLodForZoom(scheme, scheme.maxZoom)).toBe(0);
  });

  it('rejects a non-positive resolution', () => {
    expect(() => selectLodForResolution(0)).toThrow(/positive/);
    expect(() => selectLodForResolution(-1)).toThrow(/positive/);
  });
});

describe('small-feature culling', () => {
  it('scales the threshold with resolution', () => {
    expect(minFeatureSize(0.5)).toBe(2);
    expect(minFeatureSize(0.5, 8)).toBe(4);
  });

  it('drops sub-pixel features and keeps visible ones', () => {
    const res = 1; // 1 m per pixel
    expect(isTooSmallToDraw([0, 0, 0.5, 0.5], res)).toBe(true);
    expect(isTooSmallToDraw([0, 0, 100, 100], res)).toBe(false);
  });

  it('measures the diagonal, so thin long features survive', () => {
    // A 50 m long, zero-width line has a large diagonal and must not be culled.
    expect(bboxDiagonal([0, 0, 50, 0])).toBe(50);
    expect(isTooSmallToDraw([0, 0, 50, 0], 1)).toBe(false);
  });

  it('culls more aggressively as you zoom out', () => {
    const bbox = [0, 0, 3, 3] as const;
    expect(isTooSmallToDraw(bbox, resolution(scheme, scheme.maxZoom))).toBe(false);
    expect(isTooSmallToDraw(bbox, resolution(scheme, 0))).toBe(true);
  });
});
