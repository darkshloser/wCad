"""
Cross-implementation CRS parity.

This is the most important test in the repository (IMPLEMENTATION-PLAN.md section 15). If the
TypeScript and Python transforms disagree, coordinates are corrupted silently and the cause is
extremely hard to trace back from the symptom.

The TypeScript side writes fixtures/crs-points.json; this test asserts pyproj agrees with it to
within 1 mm.
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

import json
import math
from pathlib import Path

import pytest
from pyproj import CRS, Transformer

from wcad_workers.crs import CRS_DEFINITIONS

from conftest import FIXTURES_DIR

# Resolved by conftest rather than by counting parent directories: apps/workers is mounted at
# /app in the container, where walking up three levels leaves the filesystem entirely.
FIXTURE = (FIXTURES_DIR / "crs-points.json") if FIXTURES_DIR else Path("crs-points.json")
TOLERANCE_M = 0.001


def _transformer(code: str) -> Transformer:
    return Transformer.from_crs(
        CRS.from_proj4(CRS_DEFINITIONS["EPSG:4326"]),
        CRS.from_proj4(CRS_DEFINITIONS[code]),
        always_xy=True,
    )


@pytest.mark.skipif(not FIXTURE.exists(), reason="run `pnpm fixtures:generate` first")
def test_python_matches_typescript_transforms() -> None:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    failures: list[str] = []

    for code, entries in data["systems"].items():
        transformer = _transformer(code)
        for entry in entries:
            lon, lat = entry["lonlat"]
            expected_x, expected_y = entry["projected"]
            x, y = transformer.transform(lon, lat)
            dist = math.hypot(x - expected_x, y - expected_y)
            if dist > TOLERANCE_M:
                failures.append(
                    f"{code} at ({lon}, {lat}): TypeScript gave ({expected_x}, {expected_y}), "
                    f"pyproj gave ({x}, {y}), difference {dist:.6f} m"
                )

    assert not failures, "CRS definitions have diverged between TypeScript and Python:\n" + "\n".join(failures)


def test_every_typescript_crs_is_present_in_python() -> None:
    ts_codes = json.loads(FIXTURE.read_text(encoding="utf-8"))["systems"].keys() if FIXTURE.exists() else []
    missing = [c for c in ts_codes if c not in CRS_DEFINITIONS]
    assert not missing, f"CRS present in TypeScript but missing from the generated Python registry: {missing}"
