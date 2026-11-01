// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright runs against an already-running stack rather than starting its own, because the
 * budgets being measured depend on PostGIS, the tile cache and real data. A self-started dev
 * server with an empty database would produce numbers that look excellent and mean nothing.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env['WCAD_WEB_URL'] ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Headless Chromium falls back to SwiftShader without these; the numbers are still
            // conservative, but at least the WebGL path is exercised rather than skipped.
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            // Exposes performance.memory so the heap budget can be measured.
            '--enable-precise-memory-info',
          ],
        },
      },
    },
  ],
});
