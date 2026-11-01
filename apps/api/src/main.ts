// wCAD — CAD/GIS Web Application
// Copyright (C) 2026 Dobromir
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file at the root of this repository.

import { createServer } from 'node:http';

/**
 * API placeholder.
 *
 * Phase 1 delivers the foundations only, and the demo app runs entirely on the in-memory
 * reference store, so nothing here is on the critical path yet. It exists so the Docker stack
 * is complete and health-checkable from day one.
 *
 * Phase 2 replaces this with the NestJS application described in the architecture doc:
 * elements CRUD, the exact-geometry endpoint, snap candidates, tiles and WebSocket rooms.
 */

const PORT = Number(process.env['PORT'] ?? 3000);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', phase: 1, service: 'api' }));
    return;
  }
  res.writeHead(501, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      error: 'Not implemented',
      detail: 'The API lands in Phase 2. See docs/IMPLEMENTATION-PLAN.md section 6.',
    }),
  );
});

server.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} (Phase 1 placeholder)`);
});
