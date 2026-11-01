"""
Block definitions and instancing (architecture principle P5: instance, don't explode).

A site plan with 50,000 manhole symbols contains one manhole *drawing* placed 50,000 times. Storing
the exploded geometry of each placement multiplies the row count by the entity count of the block —
a 6-entity symbol turns 50,000 inserts into 300,000 rows — and every one of those rows then has to
be indexed, generalized, ranked and tiled. Storing the definition once and each placement as a
reference plus a 6-element affine transform keeps the row count equal to the number of placements,
which is what the drawing actually contains.

The cost is that instanced geometry has to be resolved somewhere. It is resolved in the database at
tile time, with one `ST_Affine` per instance against the stored definition, so exploded copies never
exist at rest.

The transform is stored as [a, b, d, e, xoff, yoff], matching PostGIS's 2D `ST_Affine` argument
order exactly, so no translation layer sits between what is stored and what is applied:

    x' = a*x + b*y + xoff
    y' = d*x + e*y + yoff
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

import logging
import math
import struct
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional

import psycopg

from .entities import MappedEntity, MappingReport, map_entity

log = logging.getLogger(__name__)

# Entity types worth reading from inside a block definition.
# Definitions written per round trip. Large enough to amortize the network, small enough that the
# batch stays bounded in memory alongside the encoded geometry it carries.
BLOCK_BATCH_SIZE = 1_000

BLOCK_CONTENT_TYPES = frozenset(
    {"BLOCK", "ENDBLK", "POINT", "LINE", "CIRCLE", "ARC", "ELLIPSE", "LWPOLYLINE", "POLYLINE", "TEXT", "MTEXT", "SOLID", "3DFACE"}
)


@dataclass
class BlockDefinition:
    name: str
    base_point: tuple[float, float]
    entities: list[MappedEntity] = field(default_factory=list)

    @property
    def entity_count(self) -> int:
        return len(self.entities)


def iter_block_definitions(path: str) -> Iterator[BlockDefinition]:
    """
    Streams the BLOCKS section without loading the document.

    ezdxf's iterdxf indexes every section and can seek to any of them, so the same machinery that
    streams modelspace works here — a 10M-entity file is never materialized just to read its
    symbol library.
    """
    from ezdxf.addons import iterdxf

    doc = iterdxf.opendxf(path)
    try:
        if "BLOCKS" not in doc.sections:
            return

        current: Optional[BlockDefinition] = None
        for entity in doc.load_entities(doc.sections["BLOCKS"] + 1, set(BLOCK_CONTENT_TYPES)):
            dxf_type = entity.dxftype()

            if dxf_type == "BLOCK":
                base = getattr(entity.dxf, "base_point", (0.0, 0.0))
                current = BlockDefinition(
                    name=str(entity.dxf.name),
                    base_point=(float(base[0]), float(base[1])),
                )
                continue

            if dxf_type == "ENDBLK":
                if current is not None:
                    yield current
                current = None
                continue

            if current is None:
                continue

            try:
                current.entities.append(map_entity(entity))
            except Exception:  # noqa: BLE001 - a bad entity must not lose the whole definition
                log.debug("skipping unmappable entity in block %s", current.name, exc_info=True)
    finally:
        doc.close()


# ------------------------------------------------------------------------------------ geometry

def _wkb_geometrycollection(parts: list[bytes], srid: int) -> bytes:
    """Wraps encoded geometries into one EWKB GEOMETRYCOLLECTION."""
    out = bytearray(struct.pack("<BIII", 1, 0x20000007, srid, len(parts)))
    for part in parts:
        # Members of a collection carry their own type but not their own SRID.
        out += _strip_srid(part)
    return bytes(out)


def _strip_srid(wkb: bytes) -> bytes:
    """Removes the SRID flag and value from an EWKB geometry, as collection members require."""
    byte_order = wkb[0:1]
    (type_code,) = struct.unpack_from("<I", wkb, 1)
    if not (type_code & 0x20000000):
        return wkb
    plain_type = type_code & ~0x20000000
    return byte_order + struct.pack("<I", plain_type) + wkb[9:]


def definition_geometry(definition: BlockDefinition, srid: int) -> Optional[bytes]:
    """Encodes a definition's entities as one GEOMETRYCOLLECTION, or None when it is empty."""
    from .importer import to_wkb

    parts: list[bytes] = []
    for entity in definition.entities:
        try:
            parts.append(to_wkb(entity.kind, entity.coords, srid))
        except ValueError:
            continue
    if not parts:
        return None
    return _wkb_geometrycollection(parts, srid)


def definition_bbox(definition: BlockDefinition) -> Optional[tuple[float, float, float, float]]:
    xs: list[float] = []
    ys: list[float] = []
    for entity in definition.entities:
        for x, y in entity.coords:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def insert_transform(
    insert_point: tuple[float, float],
    base_point: tuple[float, float],
    xscale: float,
    yscale: float,
    rotation_degrees: float,
) -> list[float]:
    """
    Builds the affine transform placing a block instance, in PostGIS `ST_Affine` argument order.

    Order of operations follows the DXF specification: the block's base point moves to the origin,
    then scale, then rotation, then translation to the insertion point. Applying rotation before
    scale would shear any instance with unequal scales — visibly wrong, and wrong in a way that
    only shows up on the minority of inserts that use them.
    """
    theta = math.radians(rotation_degrees)
    cos_t, sin_t = math.cos(theta), math.sin(theta)

    # Rotation ∘ scale.
    a = cos_t * xscale
    b = -sin_t * yscale
    d = sin_t * xscale
    e = cos_t * yscale

    # Translation carries the base-point offset through the same rotation and scale.
    xoff = insert_point[0] - (a * base_point[0] + b * base_point[1])
    yoff = insert_point[1] - (d * base_point[0] + e * base_point[1])

    return [a, b, d, e, xoff, yoff]


def apply_transform(
    transform: list[float], point: tuple[float, float]
) -> tuple[float, float]:
    """Applies a stored transform to one point. Mirrors PostGIS ST_Affine exactly."""
    a, b, d, e, xoff, yoff = transform
    x, y = point
    return (a * x + b * y + xoff, d * x + e * y + yoff)


def transformed_bbox(
    bbox: tuple[float, float, float, float], transform: list[float]
) -> tuple[float, float, float, float]:
    """
    Bounding box of a transformed block, computed from all four corners.

    Transforming only the min and max corners is wrong under rotation: a rotated rectangle's extent
    is set by whichever corners end up furthest apart, which is not generally the pair you started
    with. An instance with a wrong bbox is culled from tiles it belongs in, so it silently vanishes
    at some zoom levels.
    """
    min_x, min_y, max_x, max_y = bbox
    corners = [
        apply_transform(transform, (min_x, min_y)),
        apply_transform(transform, (max_x, min_y)),
        apply_transform(transform, (max_x, max_y)),
        apply_transform(transform, (min_x, max_y)),
    ]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    return (min(xs), min(ys), max(xs), max(ys))


# ------------------------------------------------------------------------------------ storage

class BlockLibrary:
    """
    Stores block definitions once per project and resolves them by name during import.

    Definitions are written before any entity that references them, so an INSERT never has to be
    revisited to fill in an id it could not know yet.
    """

    def __init__(self, conn: psycopg.Connection, project_id: int, srid: int) -> None:
        self._conn = conn
        self._project_id = project_id
        self._srid = srid
        self._ids: dict[str, int] = {}
        self._bboxes: dict[str, tuple[float, float, float, float]] = {}
        self._base_points: dict[str, tuple[float, float]] = {}

    @property
    def names(self) -> list[str]:
        return sorted(self._ids)

    def load(self, path: str) -> int:
        """
        Reads and stores every definition in the file. Returns how many were stored.

        Written in batches, then all ids read back in one query.

        The obvious implementation — one INSERT ... RETURNING id per definition — costs a network
        round trip each time. That is invisible on a fixture with 50 blocks and takes **nine and a
        half minutes** on one with 50,000, which alone would consume most of the 15-minute import
        budget. Batching turns 50,000 round trips into 50.
        """
        stored = 0
        pending: list[tuple] = []

        for definition in iter_block_definitions(path):
            pending.append(self._row_for(definition))
            stored += 1
            if len(pending) >= BLOCK_BATCH_SIZE:
                self._write(pending)
                pending = []

        self._write(pending)
        self._conn.commit()
        self._resolve_ids()
        return stored

    def _row_for(self, definition: BlockDefinition) -> tuple:
        """Encodes one definition and remembers what the import path needs about it."""
        geometry = definition_geometry(definition, self._srid)
        bbox = definition_bbox(definition)

        self._base_points[definition.name] = definition.base_point
        if bbox:
            self._bboxes[definition.name] = bbox

        return (
            self._project_id,
            definition.name,
            geometry.hex() if geometry else None,
            f"BOX({bbox[0]!r} {bbox[1]!r},{bbox[2]!r} {bbox[3]!r})" if bbox else None,
            list(definition.base_point),
            definition.entity_count,
        )

    def _write(self, rows: list[tuple]) -> None:
        if not rows:
            return
        with self._conn.cursor() as cur:
            # executemany, not a loop: psycopg3 pipelines these, so the batch costs one round trip
            # rather than one per row.
            cur.executemany(
                """
                INSERT INTO block_definitions (project_id, name, geometry, bbox, base_point, entity_count)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (project_id, name) DO UPDATE
                    SET geometry = EXCLUDED.geometry,
                        bbox = EXCLUDED.bbox,
                        base_point = EXCLUDED.base_point,
                        entity_count = EXCLUDED.entity_count
                """,
                rows,
            )

    def _resolve_ids(self) -> None:
        """
        Reads every definition's id in one query.

        RETURNING cannot be used with a batched executemany, so ids are fetched afterwards. One
        query for the whole library costs less than the round trips it replaces.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                "SELECT name, id FROM block_definitions WHERE project_id = %s",
                (self._project_id,),
            )
            self._ids = {name: int(block_id) for name, block_id in cur.fetchall()}

    def id_for(self, name: str) -> Optional[int]:
        return self._ids.get(name)

    def bbox_for(self, name: str) -> Optional[tuple[float, float, float, float]]:
        return self._bboxes.get(name)

    def base_point_for(self, name: str) -> tuple[float, float]:
        return self._base_points.get(name, (0.0, 0.0))

    def resolve_insert(
        self, entity: MappedEntity
    ) -> tuple[Optional[int], Optional[list[float]], Optional[tuple[float, float, float, float]]]:
        """
        Resolves an INSERT into (block_id, transform, bbox).

        Returns (None, None, None) for a block this file never defined — a dangling reference,
        which is stored as a bare point rather than dropped.
        """
        metadata = entity.metadata or {}
        name = str(metadata.get("block", ""))
        block_id = self.id_for(name)
        if block_id is None:
            return (None, None, None)

        transform = insert_transform(
            entity.coords[0],
            self.base_point_for(name),
            float(metadata.get("xscale", 1.0)),
            float(metadata.get("yscale", 1.0)),
            float(metadata.get("rotation", 0.0)),
        )

        definition_box = self.bbox_for(name)
        bbox = transformed_bbox(definition_box, transform) if definition_box else None
        return (block_id, transform, bbox)


def count_block_entities(report: MappingReport) -> int:
    """Entities that exist only inside block definitions are not modelspace entities."""
    return report.mapped
