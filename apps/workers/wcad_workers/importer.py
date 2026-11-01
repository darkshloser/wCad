"""
Streaming DXF importer.

Three properties this is built around, in order of importance.

**Nothing is lost silently.** Every entity in the file is either written, or counted and named in
the job's unsupported/failed report. The importer asserts `imported + unsupported + failed ==
entities_seen` before declaring success, and refuses to report success if that fails.

**Memory stays flat.** `ezdxf.iterdxf` yields entities without building a document, batches are
bounded, and nothing accumulates across batches. A 10M-entity file must import in the same memory
as a 10k-entity one — a memory graph that climbs is the signal that something is buffering.

**A killed worker resumes correctly.** Each batch commits its rows and its checkpoint in ONE
transaction, so the queue can never claim progress that the data does not reflect. On restart the
importer skips forward to the checkpointed entity index and continues.

Coordinates go in through binary COPY, not text: WKT truncates float64 to 15 significant digits,
which loses centimetres at UTM magnitudes and violates guardrail G2.
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
import logging
import math
import struct
from dataclasses import dataclass
from typing import Any, Iterable, Iterator, Optional

import psycopg

from .entities import MappedEntity, MappingReport, map_entities
from .profiling import MemoryProfile
from .simplify import LOD_TOLERANCES, simplify

log = logging.getLogger(__name__)

# Rows per transaction. Large enough that COPY overhead is amortized, small enough that a crash
# loses little work and the batch's memory stays bounded.
BATCH_SIZE = 10_000

# Minimum vertices a geometry kind needs to remain that kind after generalization.
MIN_VERTICES = {"polygon": 4, "polyline": 2, "line": 2, "arc": 2, "circle": 2}

STAGE_ENTITIES = "entities"
STAGE_EXTENT = "extent"


# ------------------------------------------------------------------------------------ WKB writing

def _wkb_point(x: float, y: float, srid: int) -> bytes:
    # Little-endian, EWKB with SRID flag. struct.pack('<d') writes the exact float64 bit pattern,
    # which is the whole point: no decimal formatting anywhere on this path.
    return struct.pack("<BII2d", 1, 0x20000001, srid, x, y)


def _wkb_linestring(coords: list[tuple[float, float]], srid: int) -> bytes:
    out = bytearray(struct.pack("<BIII", 1, 0x20000002, srid, len(coords)))
    for x, y in coords:
        out += struct.pack("<2d", x, y)
    return bytes(out)


def _wkb_polygon(coords: list[tuple[float, float]], srid: int) -> bytes:
    ring = list(coords)
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    out = bytearray(struct.pack("<BIIII", 1, 0x20000003, srid, 1, len(ring)))
    for x, y in ring:
        out += struct.pack("<2d", x, y)
    return bytes(out)


def to_wkb(kind: str, coords: list[tuple[float, float]], srid: int) -> bytes:
    """Encodes geometry as EWKB, preserving every bit of every coordinate (G2)."""
    if not coords:
        raise ValueError("cannot encode geometry with no coordinates")
    if kind in ("point", "text", "insert") or len(coords) == 1:
        return _wkb_point(coords[0][0], coords[0][1], srid)
    # A LINE whose endpoints coincide, or a polyline whose vertices all do, is a point in every
    # respect except its DXF type. Encoding it as a zero-length LINESTRING would store geometry
    # PostGIS considers invalid, which then breaks tile clipping for the tile that contains it.
    if distinct_vertices(coords) == 1:
        return _wkb_point(coords[0][0], coords[0][1], srid)
    if kind == "polygon":
        return _wkb_polygon(coords, srid)
    return _wkb_linestring(coords, srid)


# ------------------------------------------------------------------------------------ geometry

def bounds(coords: Iterable[tuple[float, float]]) -> tuple[float, float, float, float]:
    min_x = min_y = math.inf
    max_x = max_y = -math.inf
    for x, y in coords:
        min_x = x if x < min_x else min_x
        min_y = y if y < min_y else min_y
        max_x = x if x > max_x else max_x
        max_y = y if y > max_y else max_y
    return (min_x, min_y, max_x, max_y)


def distinct_vertices(coords: list[tuple[float, float]]) -> int:
    """
    Counts distinct positions, which is what geometry validity actually depends on.

    Douglas-Peucker always keeps the first and last vertex. On a closed shape those are the same
    point, so generalizing a tessellated circle at a coarse tolerance yields two identical
    vertices — a zero-length LINESTRING that PostGIS rejects as "too few points in geometry
    component". Counting raw vertices says 2 and passes; counting distinct ones says 1 and
    correctly refuses to build it.
    """
    return len({(x, y) for x, y in coords})


def lod_geometries(kind: str, coords: list[tuple[float, float]], srid: int) -> list[Optional[bytes]]:
    """
    Builds the geom_lod1..3 payloads.

    Generalization that collapses a geometry below the distinct-vertex count its kind requires
    yields NULL rather than a degenerate geometry: the tile query treats NULL as "too small to draw
    at this zoom", which is exactly the right answer for a circle that is now sub-pixel.
    """
    required = MIN_VERTICES.get(kind, 2)
    out: list[Optional[bytes]] = []
    for tolerance in LOD_TOLERANCES:
        if kind in ("point", "text", "insert"):
            out.append(to_wkb(kind, coords, srid))
            continue

        reduced = simplify(coords, tolerance)
        # A polygon needs 3 distinct corners; the 4th vertex of its ring is the repeated closing
        # point, which MIN_VERTICES counts but which adds no shape.
        needed = required - 1 if kind == "polygon" else required
        out.append(to_wkb(kind, reduced, srid) if distinct_vertices(reduced) >= needed else None)
    return out


# ------------------------------------------------------------------------------------ importer

@dataclass
class ImportResult:
    project_id: int
    imported: int
    seen: int
    report: MappingReport
    # Rows whose closed ring self-intersected and were stored as linework instead. Imported, not
    # lost — reported so the number is visible rather than discovered later.
    degraded: int = 0
    # Block definitions stored once (P5), and instances that resolved to one of them.
    blocks: int = 0
    instances: int = 0
    # INSERTs naming a block this file never defined. Stored as bare points rather than dropped,
    # but counted, because a drawing full of dangling references is worth knowing about.
    dangling_instances: int = 0
    # Resident set sampled per batch. "Streaming" is a claim; this is the measurement behind it.
    memory: Optional[MemoryProfile] = None

    @property
    def reconciles(self) -> bool:
        return self.report.reconciles() and self.imported == self.report.mapped


@dataclass
class Row:
    """One element as it will be written: the mapped entity plus everything resolved about it."""

    entity: MappedEntity
    layer_id: int
    block_id: Optional[int] = None
    transform: Optional[list[float]] = None
    # Present only for instances, whose footprint is the transformed block extent rather than the
    # single insertion point their geometry contains.
    bbox_override: Optional[tuple[float, float, float, float]] = None


def _build_row(mapped: MappedEntity, layers: "LayerCache", blocks) -> Row:
    layer_id = layers.id_for(mapped.layer)
    if mapped.kind != "insert":
        return Row(entity=mapped, layer_id=layer_id)

    block_id, transform, bbox = blocks.resolve_insert(mapped)
    return Row(
        entity=mapped,
        layer_id=layer_id,
        block_id=block_id,
        transform=transform,
        bbox_override=bbox,
    )


class LayerCache:
    """Resolves layer names to ids, creating them on first sight."""

    def __init__(self, conn: psycopg.Connection, project_id: int) -> None:
        self._conn = conn
        self._project_id = project_id
        self._ids: dict[str, int] = {}

    def id_for(self, name: str) -> int:
        known = self._ids.get(name)
        if known is not None:
            return known
        with self._conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO layers (project_id, name) VALUES (%s, %s)
                ON CONFLICT (project_id, name) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
                """,
                (self._project_id, name),
            )
            layer_id = int(cur.fetchone()[0])
        self._ids[name] = layer_id
        return layer_id


def iter_dxf_entities(path: str) -> Iterator[Any]:
    """
    Streams modelspace entities without loading the document.

    ezdxf.iterdxf is the only reader here that does not build an in-memory document, which is what
    makes a 10M-entity file possible at all.
    """
    # ezdxf.addons.iterdxf, not ezdxf.iterdxf: it is an add-on, not a top-level module.
    # Imported lazily so this module stays importable (and unit-testable) without ezdxf present.
    from ezdxf.addons import iterdxf

    doc = iterdxf.opendxf(path)
    try:
        yield from doc.modelspace()
    finally:
        doc.close()


def import_dxf(
    conn: psycopg.Connection,
    path: str,
    project_id: int,
    srid: int,
    *,
    batch_size: int = BATCH_SIZE,
    start_index: int = 0,
    on_batch=None,
    entities: Optional[Iterable[Any]] = None,
) -> ImportResult:
    """
    Imports a DXF into an existing project.

    `start_index` resumes a previous run: entities before it were already committed, so they are
    skipped without being re-mapped. `on_batch(committed, index, cursor)` is called inside each
    batch's transaction — that is where the job checkpoint is written, so it commits atomically
    with the rows it describes.
    """
    from .blocks import BlockLibrary

    report = MappingReport()
    layers = LayerCache(conn, project_id)
    source = entities if entities is not None else iter_dxf_entities(path)

    # Definitions are stored before any entity that references them, so an INSERT never has to be
    # revisited to fill in an id it could not know at the time (principle P5).
    blocks = BlockLibrary(conn, project_id, srid)
    block_count = 0
    if entities is None:
        block_count = blocks.load(path)
        if block_count:
            log.info("stored %s block definitions", f"{block_count:,}")

    imported = 0
    seen = 0
    instances = 0
    dangling = 0
    memory = MemoryProfile()
    batch: list[Row] = []

    def flush() -> None:
        nonlocal imported, batch
        if not batch:
            return
        with conn.cursor() as cur:
            _copy_batch(cur, batch, project_id, srid)
            imported += len(batch)
            if on_batch is not None:
                on_batch(imported, seen, cur)
        conn.commit()
        batch = []
        # After the commit, so the sample reflects steady state rather than the peak inside a
        # transaction — a batch that is about to be freed is not a leak.
        memory.record(imported)

    for mapped in map_entities(source, report):
        seen = report.total
        if report.mapped <= start_index:
            # Already committed by an earlier attempt.
            continue
        row = _build_row(mapped, layers, blocks)
        if mapped.kind == "insert":
            if row.block_id is None:
                dangling += 1
            else:
                instances += 1
        batch.append(row)
        if len(batch) >= batch_size:
            flush()

    flush()
    seen = report.total

    # Runs here rather than in the caller so the invariant "everything stored is valid geometry"
    # holds for every import path, including the tests that call this directly.
    degraded = enforce_geometry_validity(conn, project_id)
    if degraded:
        log.info("stored %s self-intersecting rings as linework", f"{degraded:,}")

    if dangling:
        log.warning("%s inserts reference a block this file never defines", f"{dangling:,}")

    return ImportResult(
        project_id=project_id,
        imported=imported,
        seen=seen,
        report=report,
        degraded=degraded,
        blocks=block_count,
        instances=instances,
        dangling_instances=dangling,
        memory=memory,
    )


def _copy_batch(
    cur: psycopg.Cursor,
    batch: list[Row],
    project_id: int,
    srid: int,
) -> None:
    """
    Writes one batch with binary COPY.

    COPY rather than INSERT because at 10M rows the per-statement overhead dominates, and binary
    rather than text because text formatting of float64 is lossy (G2).
    """
    columns = (
        "project_id, layer_id, kind, srid, geom, z_values, params, "
        "geom_lod1, geom_lod2, geom_lod3, bbox, bbox_diag, metadata, block_id, transform"
    )
    with cur.copy(f"COPY elements ({columns}) FROM STDIN") as copy:
        for row in batch:
            mapped = row.entity
            geom = to_wkb(mapped.kind, mapped.coords, srid)
            lods = lod_geometries(mapped.kind, mapped.coords, srid)

            # An instance's footprint is its transformed block extent, not the single insertion
            # point its geometry holds. Using the point would rank every instance as zero-sized and
            # cull it from the tiles its symbol actually covers.
            if row.bbox_override is not None:
                min_x, min_y, max_x, max_y = row.bbox_override
            else:
                min_x, min_y, max_x, max_y = bounds(mapped.coords)
            diag = math.hypot(max_x - min_x, max_y - min_y)

            copy.write_row(
                (
                    project_id,
                    row.layer_id,
                    mapped.code,
                    srid,
                    geom.hex(),
                    _pg_float_array(mapped.z_values),
                    json.dumps(mapped.params) if mapped.params else None,
                    lods[0].hex() if lods[0] else None,
                    lods[1].hex() if lods[1] else None,
                    lods[2].hex() if lods[2] else None,
                    f"BOX({min_x!r} {min_y!r},{max_x!r} {max_y!r})",
                    diag,
                    json.dumps(mapped.metadata) if mapped.metadata else None,
                    row.block_id,
                    _pg_float_array(row.transform),
                )
            )


def _pg_float_array(values: Optional[list[float]]) -> Optional[str]:
    if not values:
        return None
    # repr, not str: round-trip-exact float formatting for the z array.
    return "{" + ",".join(repr(v) for v in values) + "}"


def enforce_geometry_validity(conn: psycopg.Connection, project_id: int) -> int:
    """
    Stores self-intersecting closed polylines as linework rather than as invalid polygons.

    A DXF "closed polyline" is not the same thing as an OGC polygon. CAD lets a closed ring cross
    itself; a polygon may not. Roughly 4% of the random closed rings in `small.dxf` self-intersect,
    and real drawings contain them too.

    Leaving them stored as invalid polygons is not an option: `ST_AsMVTGeom` runs GEOS clipping, and
    an invalid ring can raise a TopologyException that fails the whole tile — one bad entity making
    a whole region of the drawing unrenderable.

    The fix is a change of geometry TYPE, never of coordinates. `ST_ExteriorRing` returns the ring's
    vertices untouched, so guardrail G2 still holds; `ST_MakeValid` is deliberately not used because
    it moves points, which would silently rewrite surveyed geometry.

    Returns the number of rows demoted.
    """
    polygon_code = kind_code_for_polygon()
    polyline_code = kind_code_for_polyline()

    with conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE elements
               SET kind = {polyline_code},
                   geom = ST_ExteriorRing(geom),
                   geom_lod1 = CASE WHEN geom_lod1 IS NOT NULL AND GeometryType(geom_lod1) = 'POLYGON'
                                    THEN ST_ExteriorRing(geom_lod1) ELSE geom_lod1 END,
                   geom_lod2 = CASE WHEN geom_lod2 IS NOT NULL AND GeometryType(geom_lod2) = 'POLYGON'
                                    THEN ST_ExteriorRing(geom_lod2) ELSE geom_lod2 END,
                   geom_lod3 = CASE WHEN geom_lod3 IS NOT NULL AND GeometryType(geom_lod3) = 'POLYGON'
                                    THEN ST_ExteriorRing(geom_lod3) ELSE geom_lod3 END,
                   metadata = COALESCE(metadata, '{{}}'::jsonb)
                              || '{{"degraded": "closed ring self-intersects; stored as linework"}}'::jsonb
             WHERE project_id = %s
               AND kind = {polygon_code}
               AND NOT ST_IsValid(geom)
            """,
            (project_id,),
        )
        demoted = cur.rowcount

        # Generalization can introduce a self-intersection that the full-resolution ring did not
        # have, so the LOD columns need the same treatment independently.
        for column in ("geom_lod1", "geom_lod2", "geom_lod3"):
            cur.execute(
                f"""
                UPDATE elements
                   SET {column} = ST_ExteriorRing({column})
                 WHERE project_id = %s
                   AND {column} IS NOT NULL
                   AND GeometryType({column}) = 'POLYGON'
                   AND NOT ST_IsValid({column})
                """,
                (project_id,),
            )
    conn.commit()
    return demoted


def kind_code_for_polygon() -> int:
    from .entities import kind_to_code

    return kind_to_code("polygon")


def kind_code_for_polyline() -> int:
    from .entities import kind_to_code

    return kind_to_code("polyline")


def update_project_extent(conn: psycopg.Connection, project_id: int) -> Optional[str]:
    """
    Records the project's extent.

    The tile service derives each project's pyramid from this, so a project without an extent
    cannot be tiled at all.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE projects
               SET extent = (SELECT ST_Extent(geom) FROM elements WHERE project_id = %s)
             WHERE id = %s
            """,
            (project_id, project_id),
        )
        cur.execute("SELECT Box2D(extent::geometry)::text FROM projects WHERE id = %s", (project_id,))
        row = cur.fetchone()
    conn.commit()
    return row[0] if row else None
