import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@wcad/geo-core': r('./packages/geo-core/src/index.ts'),
      '@wcad/store-contract': r('./packages/store-contract/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Phase 1 gates from IMPLEMENTATION-PLAN.md section 1.4
      thresholds: {
        'packages/geo-core/src/**': { lines: 95, branches: 90 },
        'packages/store-contract/src/**': { lines: 90, branches: 85 },
      },
    },
  },
});
