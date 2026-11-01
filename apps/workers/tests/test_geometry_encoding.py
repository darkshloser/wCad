"""
Geometry encoding and LOD degeneracy, without a database.

These properties were found the hard way — by PostGIS rejecting 640 rows — and they are cheap to
check here, so a regression does not need a running database to surface.
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

import math
import struct

import pytest

from wcad_workers.importer import (
    bounds,
    distinct_vertices,
    lod_geometries,
    to_wkb,
)

SRID = 32635
WKB_POINT = 0x20000001
WKB_LINESTRING = 0x20000002
WKB_POLYGON = 0x20000003


def geom_type(wkb: bytes) -> int:
    return struct.unpack_from("<I", wkb, 1)[0]


def tessellated_circle(cx: float, cy: float, r: float, segments: int = 64):
    return [
        (cx + r * math.cos(2 * math.pi * i / segments), cy + r * math.sin(2 * math.pi * i / segments))
        for i in range(segments + 1)
    ]


# --------------------------------------------------------------------------- distinct vertices

def test_distinct_vertices_counts_positions_not_entries():
    assert distinct_vertices([(1.0, 2.0), (1.0, 2.0)]) == 1
    assert distinct_vertices([(1.0, 2.0), (3.0, 4.0), (1.0, 2.0)]) == 2
    assert distinct_vertices([]) == 0


# --------------------------------------------------------------------------- LOD degeneracy

def test_a_circle_generalizes_to_null_before_it_generalizes_to_nonsense():
    """
    The 640-row failure.

    Douglas-Peucker always keeps the first and last vertex, and on a closed tessellation those are
    the same point. At a coarse tolerance a circle therefore reduces to two identical vertices —
    a zero-length LINESTRING that PostGIS reports as invalid ("too few points in geometry
    component"), which in turn can fail tile clipping for every feature in that tile.
    """
    circle = tessellated_circle(500_000.0, 4_650_000.0, 5.0)
    lod1, lod2, lod3 = lod_geometries("circle", circle, SRID)

    # A 5 m circle is still worth drawing at 1 m tolerance, and not at 10 m or 100 m.
    assert lod1 is not None
    assert lod2 is None, "a collapsed circle must be NULL, not a zero-length line"
    assert lod3 is None


def test_a_large_circle_survives_coarser_generalization():
    circle = tessellated_circle(500_000.0, 4_650_000.0, 400.0)
    lod1, lod2, lod3 = lod_geometries("circle", circle, SRID)

    # Sanity in the other direction: the guard must not discard geometry that is still visible.
    assert lod1 is not None and lod2 is not None


def test_points_are_never_generalized_away():
    for kind in ("point", "text", "insert"):
        lods = lod_geometries(kind, [(500_000.0, 4_650_000.0)], SRID)
        assert all(l is not None for l in lods), f"{kind} must survive every LOD"


def test_a_polygon_needs_three_distinct_corners():
    # 50 m across: still a shape at 1 m tolerance, gone at 100 m.
    square = [(0.0, 0.0), (50.0, 0.0), (50.0, 50.0), (0.0, 50.0), (0.0, 0.0)]
    lod1, lod2, lod3 = lod_geometries("polygon", square, SRID)

    assert lod1 is not None
    assert lod3 is None, "a polygon reduced below three corners is not a polygon"


# --------------------------------------------------------------------------- encoding

def test_geometry_types_match_their_kinds():
    assert geom_type(to_wkb("point", [(1.0, 2.0)], SRID)) == WKB_POINT
    assert geom_type(to_wkb("line", [(0.0, 0.0), (1.0, 1.0)], SRID)) == WKB_LINESTRING
    assert geom_type(to_wkb("polygon", [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)], SRID)) == WKB_POLYGON


def test_a_zero_length_line_is_stored_as_a_point():
    # Valid geometry beats a faithful-but-invalid type: a zero-length LINESTRING is rejected by
    # PostGIS and breaks clipping for the whole tile that contains it.
    wkb = to_wkb("line", [(1.0, 2.0), (1.0, 2.0)], SRID)
    assert geom_type(wkb) == WKB_POINT


def test_polygon_rings_are_closed_exactly_once():
    open_ring = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]
    closed_ring = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0)]

    # Both must produce the same 4-point ring; closing twice would be invalid.
    assert to_wkb("polygon", open_ring, SRID) == to_wkb("polygon", closed_ring, SRID)

    # EWKB polygon layout: byteOrder(1) + type(4) + srid(4) = 9, then ringCount(4), pointCount(4).
    wkb = to_wkb("polygon", open_ring, SRID)
    rings = struct.unpack_from("<I", wkb, 9)[0]
    points = struct.unpack_from("<I", wkb, 13)[0]
    assert rings == 1
    assert points == 4, "three corners plus the closing point"


def test_encoding_preserves_coordinates_bit_exactly():
    hostile = [
        (500123.45678901234, 4650321.104567891),
        (0.1 + 0.2, 1e-15),
    ]
    wkb = to_wkb("line", hostile, SRID)

    for i, (want_x, want_y) in enumerate(hostile):
        got_x, got_y = struct.unpack_from("<2d", wkb, 9 + 4 + i * 16)
        # G2: not close — identical.
        assert got_x == want_x
        assert got_y == want_y


def test_empty_geometry_is_an_error_not_a_silent_skip():
    with pytest.raises(ValueError):
        to_wkb("line", [], SRID)


def test_bounds_of_a_single_point_is_degenerate_not_infinite():
    assert bounds([(5.0, 7.0)]) == (5.0, 7.0, 5.0, 7.0)
