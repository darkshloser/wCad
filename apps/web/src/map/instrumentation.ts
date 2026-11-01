// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

/**
 * Client-side performance instrumentation.
 *
 * Exists so the budgets in the architecture document are measured rather than asserted: 60 fps
 * sustained, hover to highlight under 16 ms, client heap under 1.5 GB at 10M objects. The
 * automated performance tests read exactly these counters, so what CI checks and what a
 * developer sees in the status bar cannot drift apart.
 */

export interface PerfSnapshot {
  readonly fps: number;
  readonly minFps: number;
  readonly frameMs: number;
  readonly tileLoadCount: number;
  readonly tileLoadP95Ms: number;
  readonly tileErrorCount: number;
  readonly heapMb: number | null;
  readonly hitTestP95Ms: number;
}

interface MemoryInfo {
  usedJSHeapSize: number;
}

export class PerfMonitor {
  #frames = 0;
  #fps = 0;
  #minFps = Number.POSITIVE_INFINITY;
  #lastFrame = 0;
  #frameMs = 0;
  #windowStart = 0;
  #raf: number | null = null;

  readonly #tileTimes: number[] = [];
  readonly #hitTestTimes: number[] = [];
  #tileErrors = 0;

  start(): void {
    if (this.#raf !== null) return;
    this.#windowStart = performance.now();
    this.#lastFrame = this.#windowStart;

    const tick = (now: number) => {
      this.#frameMs = now - this.#lastFrame;
      this.#lastFrame = now;
      this.#frames++;

      const elapsed = now - this.#windowStart;
      if (elapsed >= 1000) {
        this.#fps = (this.#frames * 1000) / elapsed;
        // Ignore the first window: startup is not representative of steady-state rendering.
        if (this.#minFps !== Number.POSITIVE_INFINITY || this.#fps > 0) {
          this.#minFps = Math.min(this.#minFps, this.#fps);
        }
        this.#frames = 0;
        this.#windowStart = now;
      }
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
  }

  recordTileLoad(ms: number): void {
    push(this.#tileTimes, ms);
  }

  recordTileError(): void {
    this.#tileErrors++;
  }

  /** Wraps a hit test so the 16 ms interaction budget is measured on real user input. */
  measureHitTest<T>(fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      push(this.#hitTestTimes, performance.now() - t0);
    }
  }

  snapshot(): PerfSnapshot {
    const memory = (performance as unknown as { memory?: MemoryInfo }).memory;
    return {
      fps: round(this.#fps),
      minFps: this.#minFps === Number.POSITIVE_INFINITY ? 0 : round(this.#minFps),
      frameMs: round(this.#frameMs),
      tileLoadCount: this.#tileTimes.length,
      tileLoadP95Ms: round(percentile(this.#tileTimes, 0.95)),
      tileErrorCount: this.#tileErrors,
      heapMb: memory ? round(memory.usedJSHeapSize / 1024 / 1024) : null,
      hitTestP95Ms: round(percentile(this.#hitTestTimes, 0.95)),
    };
  }

  reset(): void {
    this.#tileTimes.length = 0;
    this.#hitTestTimes.length = 0;
    this.#tileErrors = 0;
    this.#minFps = Number.POSITIVE_INFINITY;
  }
}

const SAMPLE_LIMIT = 500;

function push(arr: number[], value: number): void {
  arr.push(value);
  if (arr.length > SAMPLE_LIMIT) arr.shift();
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
