// Copyright (c) 2026 Dobromir. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
//
// Use of this file is governed by the Business Source License 1.1 found in the
// LICENSE file at the root of this repository. Production use requires a
// commercial license until the Change Date, after which the Change License
// (Apache-2.0) applies.

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
