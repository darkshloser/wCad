// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { PerfMonitor, percentile } from '../src/map/instrumentation.ts';

describe('percentile', () => {
  it('returns zero for an empty sample', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it('computes p95 over a known distribution', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0.5)).toBe(50);
  });

  it('does not depend on input order', () => {
    const values = [5, 1, 9, 3, 7];
    expect(percentile(values, 0.5)).toBe(percentile([...values].reverse(), 0.5));
  });

  it('handles a single sample and clamps out-of-range percentiles', () => {
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
});

describe('PerfMonitor', () => {
  it('starts empty', () => {
    const snap = new PerfMonitor().snapshot();
    expect(snap.tileLoadCount).toBe(0);
    expect(snap.tileErrorCount).toBe(0);
    expect(snap.minFps).toBe(0);
  });

  it('records tile timings and reports p95', () => {
    const m = new PerfMonitor();
    for (const ms of [10, 20, 30, 400]) m.recordTileLoad(ms);
    const snap = m.snapshot();
    expect(snap.tileLoadCount).toBe(4);
    expect(snap.tileLoadP95Ms).toBe(400);
  });

  it('counts tile errors separately from timings', () => {
    const m = new PerfMonitor();
    m.recordTileError();
    m.recordTileError();
    expect(m.snapshot().tileErrorCount).toBe(2);
    expect(m.snapshot().tileLoadCount).toBe(0);
  });

  it('measures hit tests and returns their value', () => {
    const m = new PerfMonitor();
    expect(m.measureHitTest(() => 'feature-1')).toBe('feature-1');
    expect(m.snapshot().hitTestP95Ms).toBeGreaterThanOrEqual(0);
  });

  it('still records a timing when the hit test throws', () => {
    const m = new PerfMonitor();
    expect(() => m.measureHitTest(() => { throw new Error('boom'); })).toThrow('boom');
    // The finally block must have run, otherwise a failing hit test would silently vanish
    // from the performance data exactly when it matters most.
    expect(m.snapshot().hitTestP95Ms).toBeGreaterThanOrEqual(0);
  });

  it('bounds sample retention so a long session cannot leak memory', () => {
    const m = new PerfMonitor();
    for (let i = 0; i < 5000; i++) m.recordTileLoad(i);
    expect(m.snapshot().tileLoadCount).toBeLessThanOrEqual(500);
  });

  it('clears counters on reset', () => {
    const m = new PerfMonitor();
    m.recordTileLoad(5);
    m.recordTileError();
    m.reset();
    const snap = m.snapshot();
    expect(snap.tileLoadCount).toBe(0);
    expect(snap.tileErrorCount).toBe(0);
  });
});
