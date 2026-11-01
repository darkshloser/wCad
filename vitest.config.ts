import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wcad/geo-core': r('./packages/geo-core/src/index.ts'),
      '@wcad/store-contract': r('./packages/store-contract/src/index.ts'),
      '@wcad/tiling': r('./packages/tiling/src/index.ts'),
      '@wcad/store-postgis': r('./packages/store-postgis/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts', 'tools/**/test/**/*.test.ts'],
    // Integration suites need Docker (Testcontainers). They run in the PR gate via
    // `vitest run --project integration`, not on every commit.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Phase 1 gates from IMPLEMENTATION-PLAN.md section 1.4
      thresholds: {
        'packages/geo-core/src/**': { lines: 95, branches: 90 },
        'packages/store-contract/src/**': { lines: 90, branches: 85 },
        'packages/tiling/src/**': { lines: 95, branches: 90 },
      },
    },
  },
});
