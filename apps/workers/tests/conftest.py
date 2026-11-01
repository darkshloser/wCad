"""
Shared test setup for the worker suites.

The one job here is locating the fixtures directory, which is genuinely not the same place in
every context this test suite runs:

  * repo checkout / CI  — apps/workers/tests/… with fixtures/ three levels up
  * inside the container — apps/workers is mounted at /app, and fixtures at /fixtures

Hardcoding `parents[3]` works for the first and walks off the filesystem root in the second.
Resolving it once, here, keeps that knowledge out of every individual test.
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

import os
from pathlib import Path
from typing import Optional

import pytest

# A fixtures directory is identified by its manifest, not by its name alone, so an unrelated
# directory called "fixtures" cannot be mistaken for the real one.
MANIFEST = "manifest.json"


def _candidates() -> list[Path]:
    found: list[Path] = []

    override = os.environ.get("WCAD_FIXTURES")
    if override:
        found.append(Path(override))

    # Walk up from this file: covers the repo checkout and any nesting depth.
    here = Path(__file__).resolve()
    found.extend(parent / "fixtures" for parent in here.parents)

    # The container mount.
    found.append(Path("/fixtures"))
    return found


def find_fixtures_dir() -> Optional[Path]:
    for candidate in _candidates():
        try:
            if (candidate / MANIFEST).is_file():
                return candidate
        except OSError:
            continue
    return None


FIXTURES_DIR: Optional[Path] = find_fixtures_dir()


def fixture_path(name: str) -> Optional[Path]:
    """Absolute path to a named fixture, or None when the fixture set is not present."""
    if FIXTURES_DIR is None:
        return None
    path = FIXTURES_DIR / name
    return path if path.exists() else None


requires_fixtures = pytest.mark.skipif(
    FIXTURES_DIR is None,
    reason="fixture set not found; run `wcad.ps1 fixtures` (or set WCAD_FIXTURES)",
)


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    if FIXTURES_DIR is None:
        pytest.skip("fixture set not found; run `wcad.ps1 fixtures` (or set WCAD_FIXTURES)")
    return FIXTURES_DIR
