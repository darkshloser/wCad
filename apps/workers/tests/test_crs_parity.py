"""
Cross-implementation CRS parity.

This is the most important test in the repository (IMPLEMENTATION-PLAN.md section 15). If the
TypeScript and Python transforms disagree, coordinates are corrupted silently and the cause is
extremely hard to trace back from the symptom.

The TypeScript side writes fixtures/crs-points.json; this test asserts pyproj agrees with it to
within 1 mm.
"""

# Copyright (c) 2026 Dobromir. All rights reserved.
# SPDX-License-Identifier: BUSL-1.1
#
# Use of this file is governed by the Business Source License 1.1 found in the
# LICENSE file at the root of this repository. Production use requires a
# commercial license until the Change Date, after which the Change License
# (Apache-2.0) applies.


from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from pyproj import CRS, Transformer

from wcad_workers.crs import CRS_DEFINITIONS

FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "crs-points.json"
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
