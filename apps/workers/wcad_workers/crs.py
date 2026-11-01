"""
Python side of the shared CRS registry.

This module is GENERATED from packages/geo-core/src/crs/definitions.ts and must never be edited
by hand. Two hand-maintained copies of a projection definition will eventually diverge, and the
resulting data is shifted in a way that looks entirely plausible — the most damaging failure
mode in the system.

Regenerate with:  pnpm --filter @wcad/geo-core run gen:python
Verify with:      pytest apps/workers/tests/test_crs_parity.py
"""

# wCAD — CAD/GIS Web Application
# Copyright (C) 2026 Dobromir
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This program is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by the Free
# Software Foundation, either version 3 of the License, or (at your option) any
# later version. See the LICENSE file at the root of this repository.


from __future__ import annotations

from typing import Final

CRS_DEFINITIONS: Final[dict[str, str]] = {
    "EPSG:4326": "+proj=longlat +datum=WGS84 +no_defs",
    "EPSG:3857": (
        "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 "
        "+units=m +nadgrids=@null +no_defs"
    ),
    "EPSG:32635": "+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs",
    "EPSG:7801": (
        "+proj=lcc +lat_0=42.6678756833333 +lon_0=25.5 +lat_1=42 +lat_2=43.3333333333333 "
        "+x_0=500000 +y_0=4725824.3591 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
    ),
    "EPSG:27700": (
        "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy "
        "+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
    ),
}
