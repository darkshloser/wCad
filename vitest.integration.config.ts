import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Integration suites. These start real containers (PostGIS, Valkey) via Testcontainers, so they
 * need Docker and are far slower than the commit gate. Run in the PR gate, not on every save.
 */
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
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
