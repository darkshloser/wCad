"""
Worker entry point.

Phase 1 placeholder. Phase 3 turns this into the queued, resumable import pipeline described in
the architecture document: streaming DXF via ezdxf.iterdxf, chunked COPY into PostGIS, LOD
pyramid builds, and LandXML/OGR importers.

The one thing already fixed here is the CRS registry contract: the workers must transform
coordinates identically to the TypeScript side, and that is verified by a cross-implementation
test rather than assumed.
"""

# Copyright (c) 2026 Dobromir. All rights reserved.
# SPDX-License-Identifier: BUSL-1.1
#
# Use of this file is governed by the Business Source License 1.1 found in the
# LICENSE file at the root of this repository. Production use requires a
# commercial license until the Change Date, after which the Change License
# (Apache-2.0) applies.


from __future__ import annotations

import logging
import os
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s [worker] %(message)s")
log = logging.getLogger(__name__)


def main() -> None:
    log.info("wCAD worker starting (Phase 1 placeholder)")
    log.info("database: %s", "configured" if os.environ.get("DATABASE_URL") else "missing")
    log.info("redis:    %s", "configured" if os.environ.get("REDIS_URL") else "missing")
    log.info("Import pipeline arrives in Phase 3 — see docs/IMPLEMENTATION-PLAN.md section 7.")
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
