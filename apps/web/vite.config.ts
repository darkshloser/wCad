// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@wcad/geo-core': r('../../packages/geo-core/src/index.ts'),
      '@wcad/store-contract': r('../../packages/store-contract/src/index.ts'),
      '@wcad/tiling': r('../../packages/tiling/src/index.ts'),
    },
  },
  server: { host: '0.0.0.0', port: 5173, watch: { usePolling: true } },
});
