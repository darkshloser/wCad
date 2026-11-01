// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { expect, test } from '@playwright/test';

/**
 * Render budget tests — the client half of the Phase 2 exit gate.
 *
 * Budgets under test (architecture doc section 1):
 *   sustained 60 fps while panning and zooming, never below 30
 *   hover to highlight under 16 ms with zero network traffic
 *   client heap under 1.5 GB
 *
 * These run against the real stack, because the interesting failures are in the interaction
 * between tile loading, WebGL buffer uploads and garbage collection, and none of those exist in
 * a unit test.
 *
 * Headless Chromium reports lower and noisier frame rates than a real GPU, so the thresholds
 * here are deliberately loosened and the numbers are always printed. A failure means "go and
 * look at this on real hardware", not "ship blocked".
 */

const HEADLESS_FPS_FLOOR = 24;

test.describe('render budgets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.map canvas', { timeout: 30_000 });
    // Let tile loading and the first render settle before measuring.
    await page.waitForTimeout(3000);
  });

  test('reports which project it loaded', async ({ page }) => {
    const status = await page.locator('.status-bar .message').textContent();
    console.log(`status: ${status}`);
    // A working-set-only run is legitimate; it just means the backdrop is not under test.
    expect(status).toBeTruthy();
  });

  test('sustains frame rate while panning', async ({ page }) => {
    const box = await page.locator('.map').boundingBox();
    expect(box).not.toBeNull();

    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 30; i++) {
      await page.mouse.move(cx + Math.sin(i / 3) * 200, cy + Math.cos(i / 4) * 150);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(1500);

    const fps = await readFps(page);
    console.log(`pan fps: ${fps}`);
    expect(fps, 'frame rate collapsed during pan').toBeGreaterThan(HEADLESS_FPS_FLOOR);
  });

  test('sustains frame rate while zooming through the LOD ladder', async ({ page }) => {
    const box = await page.locator('.map').boundingBox();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Zooming crosses LOD boundaries, which is where a badly chosen generalization ladder shows
    // up as a stall rather than as a wrong picture.
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(200);
    }
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1500);

    const fps = await readFps(page);
    console.log(`zoom fps: ${fps}`);
    expect(fps, 'frame rate collapsed during zoom').toBeGreaterThan(HEADLESS_FPS_FLOOR);
  });

  test('hover hit-testing does no network traffic', async ({ page }) => {
    const tileRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/tiles/')) tileRequests.push(r.url());
    });

    const box = await page.locator('.map').boundingBox();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Settle first so any in-flight tile loads finish and are not miscounted.
    await page.waitForTimeout(2000);
    tileRequests.length = 0;

    for (let i = 0; i < 40; i++) {
      await page.mouse.move(cx + (i % 20) * 4, cy + (i % 13) * 3);
      await page.waitForTimeout(10);
    }
    await page.waitForTimeout(500);

    // Principle P3: the backend never sees interaction. Moving the cursor without changing the
    // view must not fetch anything.
    expect(tileRequests, `hover triggered ${tileRequests.length} tile requests`).toHaveLength(0);
  });

  test('stays within the client heap budget', async ({ page }) => {
    const heap = await page.evaluate(() => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return m ? m.usedJSHeapSize / 1024 / 1024 : null;
    });

    if (heap === null) {
      test.skip(true, 'performance.memory is not exposed in this browser');
      return;
    }
    console.log(`heap: ${heap.toFixed(0)} MB`);
    expect(heap, 'client heap exceeded the 1.5 GB budget').toBeLessThan(1536);
  });

  test('logs no console errors during interaction', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    const box = await page.locator('.map').boundingBox();
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(2000);

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});

/** Reads the fps counter the app already renders, so CI and the status bar cannot disagree. */
async function readFps(page: import('@playwright/test').Page): Promise<number> {
  const text = await page.locator('.status-bar .perf').first().textContent();
  const value = Number.parseFloat(text?.replace(/[^\d.]/g, '') ?? '0');
  return Number.isFinite(value) ? value : 0;
}
