"""
Cross-implementation parity for Douglas-Peucker generalization.

The expected output in fixtures/simplify-cases.json is produced by the TypeScript reference
implementation (packages/geo-core/src/simplify/douglasPeucker.ts). This asserts the Python port
agrees with it exactly — not approximately.

Why exactly: the importer writes geom_lod1..3 with the Python implementation, while the client
generalizes the working set with the TypeScript one. Any divergence means the backdrop and the
working set draw the same geometry differently, and the drawing appears to shift as elements are
selected. That is a trust-destroying bug and it is invisible in any test that compares one
implementation against itself.

Regenerate the fixture with:  wcad.ps1 fixtures
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

import pytest
from conftest import fixture_path

from wcad_workers.simplify import LOD_TOLERANCES, build_lod_pyramid, simplify

FIXTURE = fixture_path("simplify-cases.json")

pytestmark = pytest.mark.skipif(
    FIXTURE is None, reason="simplify-cases.json missing; run `wcad.ps1 fixtures`"
)


def _cases():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return data["cases"]


def test_the_fixture_covers_the_lod_ladder():
    tolerances = {c["tolerance"] for c in _cases()}
    # A parity fixture that skipped a production tolerance would leave the columns that actually
    # get written untested.
    for t in LOD_TOLERANCES:
        assert t in tolerances


@pytest.mark.parametrize("case", _cases() if FIXTURE else [], ids=lambda c: c["name"])
def test_python_simplify_matches_the_typescript_reference(case):
    points = [(p[0], p[1]) for p in case["input"]]
    expected = [(p[0], p[1]) for p in case["expected"]]

    actual = simplify(points, case["tolerance"])

    assert len(actual) == len(expected), (
        f"{case['name']}: kept {len(actual)} vertices, reference kept {len(expected)}"
    )
    for i, (got, want) in enumerate(zip(actual, expected)):
        # Bit-exact: these are the same float64 values the reference produced, and a coordinate
        # that differs in its last bits is a coordinate the two renderers disagree about.
        assert got[0] == want[0], f"{case['name']} vertex {i} x: {got[0]!r} != {want[0]!r}"
        assert got[1] == want[1], f"{case['name']} vertex {i} y: {got[1]!r} != {want[1]!r}"


def test_endpoints_always_survive():
    for case in _cases():
        points = [(p[0], p[1]) for p in case["input"]]
        if len(points) < 2:
            continue
        out = simplify(points, case["tolerance"])
        # Douglas-Peucker never moves the ends; a generalized line that starts somewhere else is
        # a different line.
        assert out[0] == points[0]
        assert out[-1] == points[-1]


def test_lod_pyramid_is_monotonic():
    points = [(i * 1.0, (i % 7) * 0.5) for i in range(400)]
    pyramid = build_lod_pyramid(points)

    assert len(pyramid) == len(LOD_TOLERANCES)
    # Coarser tolerance can never keep more vertices than a finer one.
    for finer, coarser in zip(pyramid, pyramid[1:]):
        assert len(coarser) <= len(finer)


def test_degenerate_inputs_round_trip_untouched():
    assert simplify([], 1.0) == []
    assert simplify([(1.0, 2.0)], 1.0) == [(1.0, 2.0)]
    assert simplify([(1.0, 2.0), (3.0, 4.0)], 1.0) == [(1.0, 2.0), (3.0, 4.0)]
    # A non-positive tolerance means "do not generalize", not "collapse everything".
    assert simplify([(0.0, 0.0), (1.0, 5.0), (2.0, 0.0)], 0) == [(0.0, 0.0), (1.0, 5.0), (2.0, 0.0)]


def test_a_deeply_splitting_polyline_does_not_exhaust_the_stack():
    """
    The reason both implementations use an explicit stack rather than recursion.

    The shape matters more than the length: deviations that grow along the line force Douglas-
    Peucker to split at one end repeatedly, producing recursion as deep as the vertex count rather
    than the log-depth of a balanced split. At 4,000 vertices a recursive implementation blows
    Python's default 1,000-frame limit several times over, while this stays flat.

    Deliberately not 200k vertices: DP is O(n^2) in the worst case, and in pure Python that turns
    a unit test into a coffee break without testing anything the smaller case misses.
    """
    points = [(float(i), float(i % 2) * (i * 0.01)) for i in range(4_000)]

    out = simplify(points, 0.5)

    assert out[0] == points[0]
    assert out[-1] == points[-1]
    assert len(out) > 100, "expected a shape that genuinely splits, not one that collapses"
