"""
Entity mapping tests.

The mapper is tested with lightweight stand-ins rather than real ezdxf objects: it only ever
touches `dxftype()` and `.dxf` attributes, so a stub exercises exactly the same code paths while
keeping these tests fast and independent of whether a fixture happens to contain a given entity
type. The real ezdxf integration is covered by the reconciliation tests, which read actual files.
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
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from wcad_workers.entities import (
    DXF_TYPE_TO_KIND,
    ELEMENT_KIND_CODE,
    KNOWN_UNSUPPORTED,
    MalformedEntity,
    MappingReport,
    UnsupportedEntity,
    bulge_to_arc,
    code_to_kind,
    kind_to_code,
    map_entities,
    map_entity,
    tessellate_arc,
)


class Stub:
    """Minimal stand-in for an ezdxf entity."""

    def __init__(self, dxftype: str, **attrs):
        self._type = dxftype
        self.dxf = SimpleNamespace(**attrs)

    def dxftype(self) -> str:
        return self._type


# --------------------------------------------------------------------------- kind codes

def test_kind_codes_round_trip():
    for kind, code in ELEMENT_KIND_CODE.items():
        assert code_to_kind(code) == kind
        assert kind_to_code(kind) == code


def test_unknown_kinds_raise_rather_than_defaulting():
    # Defaulting to some "other" code would store geometry under a kind nothing can read back.
    with pytest.raises(ValueError):
        kind_to_code("hyperboloid")
    with pytest.raises(ValueError):
        code_to_kind(999)


def test_kind_codes_match_the_typescript_contract():
    """
    Guards the cross-language contract by reading kinds.ts, not by trusting a comment.

    `elements.kind` is a smallint written by this importer and read by both stores. If the two
    sides disagree about what a 3 means, geometry is silently reinterpreted — the kind of bug that
    surfaces months later as "some polylines became polygons".
    """
    here = Path(__file__).resolve()
    kinds_ts = None
    for parent in here.parents:
        candidate = parent / "packages" / "store-contract" / "src" / "kinds.ts"
        if candidate.is_file():
            kinds_ts = candidate
            break

    if kinds_ts is None:
        pytest.skip("kinds.ts not reachable (running from a packaged image without the monorepo)")

    source = kinds_ts.read_text(encoding="utf-8")
    block = re.search(r"ELEMENT_KIND_CODE[^=]*=\s*\{(.*?)\}", source, re.S)
    assert block, "could not locate ELEMENT_KIND_CODE in kinds.ts"

    ts_codes = {
        m.group(1): int(m.group(2))
        for m in re.finditer(r"(\w+)\s*:\s*(\d+)", block.group(1))
    }

    assert ts_codes == ELEMENT_KIND_CODE


# --------------------------------------------------------------------------- simple geometry

def test_point_maps_with_elevation():
    e = Stub("POINT", location=(500_000.5, 4_650_000.25, 12.5), layer="SURVEY")
    m = map_entity(e)

    assert m.kind == "point"
    assert m.layer == "SURVEY"
    assert m.coords == [(500_000.5, 4_650_000.25)]
    assert m.z_values == [12.5]


def test_line_maps_both_endpoints():
    e = Stub("LINE", start=(0.0, 0.0, 1.0), end=(10.0, 5.0, 2.0), layer="PARCELS")
    m = map_entity(e)

    assert m.kind == "line"
    assert m.coords == [(0.0, 0.0), (10.0, 5.0)]
    assert m.z_values == [1.0, 2.0]


def test_missing_layer_falls_back_to_zero():
    # DXF's default layer is "0"; an entity without one is normal, not an error.
    e = Stub("POINT", location=(1.0, 2.0), layer=None)
    assert map_entity(e).layer == "0"


def test_text_keeps_its_content_as_metadata():
    e = Stub("TEXT", insert=(5.0, 6.0, 0.0), text="ID-1234", height=2.5, layer="ANNOTATION")
    m = map_entity(e)

    assert m.kind == "text"
    assert m.metadata["text"] == "ID-1234"
    assert m.metadata["height"] == 2.5


def test_insert_stores_placement_not_exploded_geometry():
    e = Stub(
        "INSERT",
        insert=(100.0, 200.0, 0.0),
        name="MANHOLE",
        xscale=2.0,
        yscale=2.0,
        rotation=45.0,
        layer="UTILITIES",
    )
    m = map_entity(e)

    # Principle P5: one stored definition, many cheap placements.
    assert m.kind == "insert"
    assert m.coords == [(100.0, 200.0)]
    assert m.metadata["block"] == "MANHOLE"
    assert m.metadata["xscale"] == 2.0
    assert m.metadata["rotation"] == 45.0


# --------------------------------------------------------------------------- curves

def test_circle_keeps_parametric_definition_alongside_tessellation():
    e = Stub("CIRCLE", center=(10.0, 20.0), radius=5.0, layer="UTILITIES")
    m = map_entity(e)

    assert m.kind == "circle"
    # The parameters are authoritative; the coordinates are for display and indexing (P1).
    assert m.params == {"cx": 10.0, "cy": 20.0, "r": 5.0}
    assert len(m.coords) > 8
    for x, y in m.coords:
        assert math.isclose(math.hypot(x - 10.0, y - 20.0), 5.0, rel_tol=1e-9)


def test_arc_records_angles_in_radians():
    e = Stub("ARC", center=(0.0, 0.0), radius=10.0, start_angle=0.0, end_angle=90.0, layer="0")
    m = map_entity(e)

    assert m.kind == "arc"
    assert m.params["startAngle"] == 0.0
    assert math.isclose(m.params["endAngle"], math.pi / 2)
    # Endpoints come from the angles exactly, never from interpolation.
    assert math.isclose(m.coords[0][0], 10.0, abs_tol=1e-9)
    assert math.isclose(m.coords[-1][1], 10.0, abs_tol=1e-9)


def test_arc_tessellation_respects_the_sagitta_tolerance():
    coarse = tessellate_arc(0, 0, 100, 0, math.pi, tolerance=1.0)
    fine = tessellate_arc(0, 0, 100, 0, math.pi, tolerance=0.001)

    assert len(fine) > len(coarse)

    # Every sampled point is on the circle, and the chord midpoints stay within tolerance.
    for x, y in fine:
        assert math.isclose(math.hypot(x, y), 100.0, rel_tol=1e-9)
    for (x1, y1), (x2, y2) in zip(fine, fine[1:]):
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        sagitta = 100.0 - math.hypot(mx, my)
        assert sagitta <= 0.001 * 1.05


def test_zero_radius_arc_is_malformed_not_silently_skipped():
    e = Stub("ARC", center=(0.0, 0.0), radius=0.0, start_angle=0.0, end_angle=90.0, layer="0")
    with pytest.raises(MalformedEntity):
        map_entity(e)


def test_bulge_converts_to_an_arc_through_both_endpoints():
    p1, p2 = (0.0, 0.0), (10.0, 0.0)
    cx, cy, radius, start, end = bulge_to_arc(p1, p2, 1.0)  # semicircle

    assert math.isclose(cx, 5.0, abs_tol=1e-9)
    assert math.isclose(radius, 5.0, abs_tol=1e-9)
    assert math.isclose(math.hypot(p1[0] - cx, p1[1] - cy), radius, abs_tol=1e-9)
    assert math.isclose(math.hypot(p2[0] - cx, p2[1] - cy), radius, abs_tol=1e-9)


# --------------------------------------------------------------------------- polylines

class PolylineStub(Stub):
    def __init__(self, points, closed=False, layer="0"):
        super().__init__("LWPOLYLINE", layer=layer, flags=1 if closed else 0)
        self._points = points
        self.closed = closed

    def get_points(self, fmt="xyb"):
        return self._points


def test_open_polyline_maps_to_polyline():
    e = PolylineStub([(0, 0, 0), (10, 0, 0), (10, 10, 0)])
    m = map_entity(e)

    assert m.kind == "polyline"
    assert m.coords == [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]


def test_closed_polyline_maps_to_polygon():
    e = PolylineStub([(0, 0, 0), (10, 0, 0), (10, 10, 0)], closed=True)
    m = map_entity(e)

    assert m.kind == "polygon"
    # Closure is applied once by the writer, so the ring is not pre-closed here.
    assert m.coords[0] != m.coords[-1]


def test_polyline_bulge_segments_are_curved_not_straightened():
    straight = map_entity(PolylineStub([(0, 0, 0), (10, 0, 0)]))
    curved = map_entity(PolylineStub([(0, 0, 1.0), (10, 0, 0)]))

    # A bulge that is silently dropped would produce identical geometry — the failure mode this
    # test exists to catch, since the result still looks like a valid drawing.
    assert len(curved.coords) > len(straight.coords)
    assert curved.coords[0] == (0.0, 0.0)
    assert math.isclose(curved.coords[-1][0], 10.0, abs_tol=1e-9)


def test_single_vertex_polyline_is_malformed():
    with pytest.raises(MalformedEntity):
        map_entity(PolylineStub([(0, 0, 0)]))


# --------------------------------------------------------------------------- reporting

def test_known_unsupported_types_are_reported_by_name():
    e = Stub("3DSOLID", layer="0")
    with pytest.raises(UnsupportedEntity) as exc:
        map_entity(e)
    assert "3DSOLID" in str(exc.value)


def test_every_known_unsupported_type_is_absent_from_the_supported_map():
    # A type in both maps would be imported and reported as skipped at the same time.
    assert not (KNOWN_UNSUPPORTED & set(DXF_TYPE_TO_KIND))


def test_report_accounts_for_every_entity_seen():
    entities = [
        Stub("POINT", location=(1.0, 2.0), layer="A"),
        Stub("LINE", start=(0.0, 0.0), end=(1.0, 1.0), layer="A"),
        Stub("3DSOLID", layer="A"),
        Stub("HATCH", layer="A"),
        Stub("ARC", center=(0.0, 0.0), radius=0.0, start_angle=0.0, end_angle=90.0, layer="A"),
    ]
    report = MappingReport()

    mapped = list(map_entities(entities, report))

    assert len(mapped) == 2
    assert report.total == 5
    assert report.mapped == 2
    assert report.unsupported_total == 2
    assert report.failed_total == 1
    # The invariant the whole import contract rests on: nothing disappears unaccounted for.
    assert report.reconciles()


def test_report_names_what_it_could_not_import():
    report = MappingReport()
    list(map_entities([Stub("HATCH", layer="A"), Stub("HATCH", layer="B")], report))

    assert report.unsupported["HATCH"] == 2
    assert report.summary()["unsupported"] == {"HATCH": 2}


def test_a_broken_entity_does_not_abort_the_stream():
    class Exploding(Stub):
        def dxftype(self):
            return "LINE"

        def __getattr__(self, name):
            raise RuntimeError("corrupt entity")

    entities = [
        Exploding("LINE"),
        Stub("POINT", location=(1.0, 2.0), layer="A"),
    ]
    report = MappingReport()

    mapped = list(map_entities(entities, report))

    # A 10M-entity import must not die on entity 3.
    assert len(mapped) == 1
    assert report.failed_total == 1
    assert report.reconciles()


def test_error_list_is_bounded_but_counts_stay_exact():
    report = MappingReport(max_errors=10)
    broken = [
        Stub("ARC", center=(0.0, 0.0), radius=0.0, start_angle=0.0, end_angle=90.0, layer="0")
        for _ in range(50)
    ]
    list(map_entities(broken, report))

    assert len(report.errors) == 10, "error list must stay readable"
    assert report.failed["ARC"] == 50, "counts must remain exact"
    assert report.reconciles()
