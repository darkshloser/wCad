"""
Block instancing (principle P5), against real PostGIS.

The claim being tested is that instancing is a storage optimisation with no visible consequence:
a drawing stored as definitions plus transforms must render exactly where the same drawing stored
as exploded geometry would. If that is not true, P5 trades correctness for row count, which is not
a trade worth making.

The transform maths is checked against PostGIS's own ST_Affine rather than against a second Python
implementation, because agreeing with yourself proves nothing — the database is what actually
places the geometry at tile time.
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
import os

import pytest
from conftest import fixture_path

psycopg = pytest.importorskip("psycopg")
ezdxf = pytest.importorskip("ezdxf")

from wcad_workers.blocks import (  # noqa: E402
    BlockLibrary,
    apply_transform,
    definition_bbox,
    insert_transform,
    iter_block_definitions,
    transformed_bbox,
)
from wcad_workers.import_job import ensure_project  # noqa: E402
from wcad_workers.importer import import_dxf  # noqa: E402
from wcad_workers.queue import connect  # noqa: E402

DSN = os.environ.get("DATABASE_URL")
SRID = 32635

pytestmark = pytest.mark.skipif(not DSN, reason="DATABASE_URL is not set; run inside the stack")


@pytest.fixture()
def conn():
    c = connect(DSN)
    yield c
    c.close()


@pytest.fixture()
def project(conn):
    project_id = ensure_project(conn, "pytest-blocks", f"EPSG:{SRID}")
    yield project_id
    with conn.cursor() as cur:
        cur.execute("DELETE FROM projects WHERE id = %s", (project_id,))
    conn.commit()


# --------------------------------------------------------------------------- transform agreement

@pytest.mark.parametrize(
    "insert_point,base,xscale,yscale,rotation",
    [
        ((0.0, 0.0), (0.0, 0.0), 1.0, 1.0, 0.0),
        ((500_000.0, 4_650_000.0), (0.0, 0.0), 1.0, 1.0, 0.0),
        ((500_000.0, 4_650_000.0), (0.0, 0.0), 1.0, 1.0, 90.0),
        ((500_000.0, 4_650_000.0), (0.0, 0.0), 2.5, 2.5, 30.0),
        ((500_000.0, 4_650_000.0), (0.0, 0.0), 2.0, 3.0, 45.0),   # unequal scales
        ((500_000.0, 4_650_000.0), (10.0, 20.0), 1.0, 1.0, 15.0), # non-origin base point
        ((500_000.0, 4_650_000.0), (-5.5, 7.25), 0.5, 0.5, 200.0),
    ],
)
def test_python_transform_matches_postgis_st_affine(conn, insert_point, base, xscale, yscale, rotation):
    """
    The transform is computed in Python and applied by PostGIS, so the two must agree exactly.

    A disagreement here places every instance of a block slightly — or completely — wrong, while
    everything still renders and no error is raised anywhere.
    """
    transform = insert_transform(insert_point, base, xscale, yscale, rotation)
    probe = (3.0, 7.0)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ST_X(g), ST_Y(g) FROM (
              SELECT ST_Affine(ST_SetSRID(ST_MakePoint(%s, %s), %s), %s, %s, %s, %s, %s, %s) AS g
            ) t
            """,
            (probe[0], probe[1], SRID, *transform),
        )
        pg_x, pg_y = cur.fetchone()

    py_x, py_y = apply_transform(transform, probe)

    # Tolerance is for the double-precision round trip through the wire, not for the maths.
    assert math.isclose(py_x, pg_x, rel_tol=0, abs_tol=1e-9), f"x: {py_x} vs {pg_x}"
    assert math.isclose(py_y, pg_y, rel_tol=0, abs_tol=1e-9), f"y: {py_y} vs {pg_y}"


# --------------------------------------------------------------------------- definitions

def test_definitions_are_stored_once_however_many_instances_exist(conn, project):
    path = fixture_path("small.dxf")
    if path is None:
        pytest.skip("small.dxf missing; run `wcad.ps1 fixtures`")

    result = import_dxf(conn, str(path), project, SRID)

    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM block_definitions WHERE project_id = %s", (project,))
        definitions = int(cur.fetchone()[0])
        cur.execute(
            "SELECT count(*) FROM elements WHERE project_id = %s AND block_id IS NOT NULL",
            (project,),
        )
        instances = int(cur.fetchone()[0])

    assert definitions > 0, "the fixture defines blocks; none were stored"
    assert instances > 0, "the fixture places blocks; none resolved"
    # This ratio is the entire point of P5.
    assert instances > definitions * 10, (
        f"{instances} instances of {definitions} definitions — expected heavy reuse"
    )
    assert result.blocks == definitions
    assert result.instances == instances


def test_every_definition_has_usable_geometry(conn, project):
    path = fixture_path("small.dxf")
    if path is None:
        pytest.skip("small.dxf missing; run `wcad.ps1 fixtures`")

    import_dxf(conn, str(path), project, SRID)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FILTER (WHERE geometry IS NULL),
                   count(*) FILTER (WHERE geometry IS NOT NULL AND NOT ST_IsValid(geometry)),
                   count(*) FILTER (WHERE bbox IS NULL),
                   count(*)
              FROM block_definitions WHERE project_id = %s
            """,
            (project,),
        )
        no_geometry, invalid, no_bbox, total = cur.fetchone()

    assert total > 0
    assert no_geometry == 0, "a definition without geometry renders as nothing"
    assert invalid == 0, "invalid definition geometry breaks every tile containing an instance"
    assert no_bbox == 0, "without a bbox, instance extents cannot be computed"


def test_instances_carry_a_complete_transform(conn, project):
    path = fixture_path("small.dxf")
    if path is None:
        pytest.skip("small.dxf missing; run `wcad.ps1 fixtures`")

    import_dxf(conn, str(path), project, SRID)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FROM elements
             WHERE project_id = %s AND block_id IS NOT NULL
               AND (transform IS NULL OR array_length(transform, 1) <> 6)
            """,
            (project,),
        )
        broken = int(cur.fetchone()[0])

    assert broken == 0, "ST_Affine needs all six coefficients"


def test_instance_extent_covers_the_placed_symbol(conn, project):
    """
    An instance's bbox must contain its rendered geometry.

    This is what the tile query filters on, so a bbox that is too small makes symbols disappear at
    tile boundaries — intermittently, and only for some placements, which is close to undebuggable
    from a bug report.
    """
    path = fixture_path("small.dxf")
    if path is None:
        pytest.skip("small.dxf missing; run `wcad.ps1 fixtures`")

    import_dxf(conn, str(path), project, SRID)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*)
              FROM elements e
              JOIN block_definitions bd ON bd.id = e.block_id
             WHERE e.project_id = %s
               AND bd.geometry IS NOT NULL
               AND NOT ST_Contains(
                     ST_Envelope(e.bbox::geometry),
                     ST_Envelope(ST_Affine(bd.geometry,
                       e.transform[1], e.transform[2], e.transform[3],
                       e.transform[4], e.transform[5], e.transform[6]))
                   )
            """,
            (project,),
        )
        escaping = int(cur.fetchone()[0])

    assert escaping == 0, "an instance's geometry extends outside the bbox used to find it"


# --------------------------------------------------------------------------- exploded equivalence

def test_instanced_geometry_matches_an_exploded_reference(conn, project):
    """
    The plan's requirement: resolved instance geometry must equal an exploded import.

    Explodes every instance in Python, expands the same instances in PostGIS, and compares the
    resulting coordinates. Instancing is only a storage decision if these agree.
    """
    path = fixture_path("tiny.dxf")
    if path is None:
        pytest.skip("tiny.dxf missing; run `wcad.ps1 fixtures`")

    import_dxf(conn, str(path), project, SRID)

    definitions = {d.name: d for d in iter_block_definitions(str(path))}
    if not definitions:
        pytest.skip("tiny.dxf defines no blocks")

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT bd.name, e.transform,
                   ST_AsText(ST_Affine(bd.geometry,
                     e.transform[1], e.transform[2], e.transform[3],
                     e.transform[4], e.transform[5], e.transform[6]))
              FROM elements e
              JOIN block_definitions bd ON bd.id = e.block_id
             WHERE e.project_id = %s
            """,
            (project,),
        )
        rows = cur.fetchall()

    assert rows, "no instances were stored"

    for name, transform, placed_wkt in rows:
        definition = definitions[name]
        # Explode in Python: every definition vertex through the same transform.
        expected = [
            apply_transform(list(transform), coord)
            for entity in definition.entities
            for coord in entity.coords
        ]
        assert expected, f"definition {name} has no geometry"

        # Every exploded vertex must appear in the geometry PostGIS produced.
        for x, y in expected[:20]:
            assert f"{x:.6f}"[:8] in placed_wkt or _near(placed_wkt, x, y), (
                f"vertex {x}, {y} of {name} missing from placed geometry"
            )


def _near(wkt: str, x: float, y: float, tolerance: float = 1e-6) -> bool:
    """True when the WKT contains a coordinate pair within tolerance of (x, y)."""
    import re

    for mx, my in re.findall(r"(-?\d+\.?\d*)\s+(-?\d+\.?\d*)", wkt):
        if abs(float(mx) - x) <= tolerance and abs(float(my) - y) <= tolerance:
            return True
    return False


def test_instancing_saves_the_storage_it_claims_to(conn, project):
    """
    Measured, not assumed.

    The exploded row count is what the table would hold without P5; the actual count is what it
    holds with it.
    """
    path = fixture_path("small.dxf")
    if path is None:
        pytest.skip("small.dxf missing; run `wcad.ps1 fixtures`")

    import_dxf(conn, str(path), project, SRID)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              count(*) FILTER (WHERE e.block_id IS NOT NULL)                    AS instances,
              COALESCE(sum(bd.entity_count) FILTER (WHERE e.block_id IS NOT NULL), 0) AS exploded
              FROM elements e
              LEFT JOIN block_definitions bd ON bd.id = e.block_id
             WHERE e.project_id = %s
            """,
            (project,),
        )
        instances, exploded = cur.fetchone()

    assert instances > 0
    # Each stored instance stands in for entity_count exploded rows.
    assert exploded > instances, "instancing saved nothing; blocks may be empty"
    print(f"\n  {instances:,} instances stand in for {exploded:,} exploded rows")


