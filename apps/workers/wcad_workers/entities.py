"""
DXF entity mapping registry.

Two rules govern this module.

First, the mapping is EXPLICIT. A DXF file can contain entity types this application has no
representation for, and the wrong response is to quietly skip them: a surveyor who imports a
drawing and gets 94% of it back, with no indication which 6% vanished, has been given corrupted
data that looks complete. Every entity is either mapped or counted by type and reported, and the
reconciliation test asserts that those two numbers add up to the number of entities in the file.

Second, the kind codes must match `packages/store-contract/src/kinds.ts` exactly. They are what is
physically stored in `elements.kind`, so a disagreement between the importer and the readers
silently reinterprets geometry — a 3 that means polyline on one side and polygon on the other.
test_entity_kind_parity.py reads the TypeScript source and asserts the two agree, rather than
trusting this comment.
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
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Final, Iterable, Optional

# Mirrors ELEMENT_KIND_CODE in packages/store-contract/src/kinds.ts. APPEND-ONLY: renumbering an
# existing kind reinterprets every row already written.
ELEMENT_KIND_CODE: Final[dict[str, int]] = {
    "point": 1,
    "line": 2,
    "polyline": 3,
    "polygon": 4,
    "arc": 5,
    "circle": 6,
    "text": 7,
    "insert": 8,
}

ELEMENT_KIND_BY_CODE: Final[dict[int, str]] = {v: k for k, v in ELEMENT_KIND_CODE.items()}


def kind_to_code(kind: str) -> int:
    try:
        return ELEMENT_KIND_CODE[kind]
    except KeyError:
        raise ValueError(f"Unknown element kind: {kind}") from None


def code_to_kind(code: int) -> str:
    try:
        return ELEMENT_KIND_BY_CODE[code]
    except KeyError:
        raise ValueError(f"Unknown element kind code: {code}") from None


# DXF type -> internal kind. Types absent from this map are reported as unsupported, by name.
#
# LWPOLYLINE and POLYLINE map to polyline or polygon depending on their closed flag, so they are
# resolved in the mapper rather than here.
DXF_TYPE_TO_KIND: Final[dict[str, str]] = {
    "POINT": "point",
    "LINE": "line",
    "LWPOLYLINE": "polyline",
    "POLYLINE": "polyline",
    "ARC": "arc",
    "CIRCLE": "circle",
    "ELLIPSE": "arc",
    "TEXT": "text",
    "MTEXT": "text",
    "INSERT": "insert",
    "SOLID": "polygon",
    "3DFACE": "polygon",
    "VERTEX": "point",
}

# Types known to exist and deliberately not imported yet, separated from "never heard of it" so
# the report can say "not supported yet" rather than implying the file is malformed.
KNOWN_UNSUPPORTED: Final[frozenset[str]] = frozenset(
    {
        "3DSOLID",
        "REGION",
        "BODY",
        "SURFACE",
        "MESH",
        "SPLINE",
        "HELIX",
        "LEADER",
        "MULTILEADER",
        "MLINE",
        "HATCH",
        "IMAGE",
        "WIPEOUT",
        "DIMENSION",
        "TOLERANCE",
        "RAY",
        "XLINE",
        "ATTDEF",
        "ATTRIB",
    }
)

# Arc tessellation must agree with the TypeScript side (geo-core/arc/tessellate.ts), which chooses
# a segment count from sagitta error. The same default tolerance is used here.
DEFAULT_SAGITTA_TOLERANCE: Final[float] = 0.01
MAX_ARC_SEGMENTS: Final[int] = 4096


@dataclass
class MappedEntity:
    """One DXF entity translated into the storage model."""

    kind: str
    layer: str
    coords: list[tuple[float, float]]
    # Canonical parametric definition for curved geometry. The tessellated coords are for display
    # and spatial indexing; this is what precision-sensitive code reads (principle P1).
    params: Optional[dict[str, float]] = None
    z_values: Optional[list[float]] = None
    metadata: Optional[dict[str, Any]] = None

    @property
    def code(self) -> int:
        return kind_to_code(self.kind)


@dataclass
class MappingReport:
    """
    Running tally for one import.

    `total` counts every entity seen, so `mapped + unsupported + failed == total` is an invariant
    the reconciliation test checks against the file itself.
    """

    total: int = 0
    mapped: int = 0
    unsupported: Counter = field(default_factory=Counter)
    failed: Counter = field(default_factory=Counter)
    errors: list[dict[str, Any]] = field(default_factory=list)

    # Bounds the error list so one systematically broken file cannot exhaust memory or produce a
    # report nobody can read. The counters stay exact.
    max_errors: int = 100

    @property
    def unsupported_total(self) -> int:
        return sum(self.unsupported.values())

    @property
    def failed_total(self) -> int:
        return sum(self.failed.values())

    def record_unsupported(self, dxf_type: str) -> None:
        self.total += 1
        self.unsupported[dxf_type] += 1

    def record_mapped(self) -> None:
        self.total += 1
        self.mapped += 1

    def record_failure(self, dxf_type: str, reason: str, handle: Optional[str] = None) -> None:
        self.total += 1
        self.failed[dxf_type] += 1
        if len(self.errors) < self.max_errors:
            self.errors.append({"type": dxf_type, "reason": reason, "handle": handle})

    def reconciles(self) -> bool:
        return self.mapped + self.unsupported_total + self.failed_total == self.total

    def summary(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "mapped": self.mapped,
            "unsupported": dict(self.unsupported),
            "unsupported_total": self.unsupported_total,
            "failed": dict(self.failed),
            "failed_total": self.failed_total,
            "errors": self.errors,
        }


class UnsupportedEntity(Exception):
    """Raised for an entity type this importer has no representation for."""


class MalformedEntity(Exception):
    """Raised for an entity of a supported type whose data cannot be used."""


def _xy(point: Any) -> tuple[float, float]:
    """Extracts (x, y) from an ezdxf point-like value without importing ezdxf."""
    try:
        return (float(point[0]), float(point[1]))
    except (TypeError, IndexError, ValueError) as exc:
        raise MalformedEntity(f"unreadable point: {point!r}") from exc


def _z(point: Any) -> float:
    try:
        return float(point[2])
    except (TypeError, IndexError, ValueError):
        return 0.0


def tessellate_arc(
    cx: float,
    cy: float,
    radius: float,
    start_angle: float,
    end_angle: float,
    tolerance: float = DEFAULT_SAGITTA_TOLERANCE,
) -> list[tuple[float, float]]:
    """
    Samples an arc densely enough that the sagitta error stays under `tolerance`.

    Endpoints are produced from the angles exactly, not interpolated, so a tessellated arc always
    starts and ends where its parametric definition says it does.
    """
    if not (radius > 0):
        raise MalformedEntity(f"arc radius must be positive, got {radius}")

    sweep = end_angle - start_angle
    while sweep <= 0:
        sweep += 2 * math.pi

    if tolerance <= 0 or tolerance >= radius:
        segments = 8
    else:
        # Largest angular step whose sagitta stays within tolerance.
        max_step = 2 * math.acos(max(-1.0, min(1.0, 1 - tolerance / radius)))
        segments = 8 if max_step <= 0 else max(2, math.ceil(sweep / max_step))
    segments = min(segments, MAX_ARC_SEGMENTS)

    points = [
        (cx + radius * math.cos(start_angle + sweep * i / segments),
         cy + radius * math.sin(start_angle + sweep * i / segments))
        for i in range(segments + 1)
    ]
    return points


def bulge_to_arc(
    p1: tuple[float, float], p2: tuple[float, float], bulge: float
) -> tuple[float, float, float, float, float]:
    """
    Converts a DXF bulge segment to (cx, cy, radius, start_angle, end_angle).

    Bulge is the tangent of a quarter of the included angle — the DXF format's compact way of
    storing an arc inside a polyline. Mirrors geo-core/arc/bulge.ts.
    """
    if bulge == 0:
        raise MalformedEntity("bulge of zero is a straight segment, not an arc")

    chord_x, chord_y = p2[0] - p1[0], p2[1] - p1[1]
    chord = math.hypot(chord_x, chord_y)
    if chord == 0:
        raise MalformedEntity("bulge segment has zero-length chord")

    included = 4 * math.atan(abs(bulge))
    radius = chord / (2 * math.sin(included / 2))
    # Distance from chord midpoint to centre, signed by bulge direction.
    apothem = radius * math.cos(included / 2)
    mid_x, mid_y = (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2
    nx, ny = -chord_y / chord, chord_x / chord
    sign = 1.0 if bulge > 0 else -1.0
    cx, cy = mid_x - sign * apothem * nx, mid_y - sign * apothem * ny

    start = math.atan2(p1[1] - cy, p1[0] - cx)
    end = math.atan2(p2[1] - cy, p2[0] - cx)
    return (cx, cy, radius, start, end)


def map_entity(entity: Any, tolerance: float = DEFAULT_SAGITTA_TOLERANCE) -> MappedEntity:
    """
    Translates one ezdxf entity into the storage model.

    Raises UnsupportedEntity or MalformedEntity rather than returning None, so a caller cannot
    accidentally treat "nothing to store" and "something went wrong" as the same outcome — that
    conflation is how silent data loss starts.
    """
    dxf_type = str(entity.dxftype())

    if dxf_type in KNOWN_UNSUPPORTED:
        raise UnsupportedEntity(dxf_type)
    if dxf_type not in DXF_TYPE_TO_KIND:
        raise UnsupportedEntity(dxf_type)

    layer = str(getattr(entity.dxf, "layer", "0") or "0")

    if dxf_type == "POINT":
        p = _xy(entity.dxf.location)
        return MappedEntity("point", layer, [p], z_values=[_z(entity.dxf.location)])

    if dxf_type == "LINE":
        a, b = _xy(entity.dxf.start), _xy(entity.dxf.end)
        return MappedEntity(
            "line", layer, [a, b], z_values=[_z(entity.dxf.start), _z(entity.dxf.end)]
        )

    if dxf_type == "CIRCLE":
        centre = _xy(entity.dxf.center)
        radius = float(entity.dxf.radius)
        coords = tessellate_arc(centre[0], centre[1], radius, 0.0, 2 * math.pi, tolerance)
        return MappedEntity(
            "circle",
            layer,
            coords,
            params={"cx": centre[0], "cy": centre[1], "r": radius},
        )

    if dxf_type == "ARC":
        centre = _xy(entity.dxf.center)
        radius = float(entity.dxf.radius)
        start = math.radians(float(entity.dxf.start_angle))
        end = math.radians(float(entity.dxf.end_angle))
        coords = tessellate_arc(centre[0], centre[1], radius, start, end, tolerance)
        return MappedEntity(
            "arc",
            layer,
            coords,
            params={
                "cx": centre[0],
                "cy": centre[1],
                "r": radius,
                "startAngle": start,
                "endAngle": end,
                "ccw": 1.0,
            },
        )

    if dxf_type == "ELLIPSE":
        # Stored as an arc kind with its own parameters; a full ellipse primitive is future work,
        # and approximating it as a circle would be wrong rather than merely coarse.
        centre = _xy(entity.dxf.center)
        major = _xy(entity.dxf.major_axis)
        ratio = float(getattr(entity.dxf, "ratio", 1.0))
        major_len = math.hypot(major[0], major[1])
        if major_len <= 0:
            raise MalformedEntity("ellipse has zero-length major axis")
        start = float(getattr(entity.dxf, "start_param", 0.0))
        end = float(getattr(entity.dxf, "end_param", 2 * math.pi))
        rotation = math.atan2(major[1], major[0])
        coords = _tessellate_ellipse(centre, major_len, major_len * ratio, rotation, start, end)
        return MappedEntity(
            "arc",
            layer,
            coords,
            params={
                "cx": centre[0],
                "cy": centre[1],
                "r": major_len,
                "ratio": ratio,
                "rotation": rotation,
                "startAngle": start,
                "endAngle": end,
                "ccw": 1.0,
            },
        )

    if dxf_type in ("TEXT", "MTEXT"):
        anchor = getattr(entity.dxf, "insert", None) or getattr(entity.dxf, "location", None)
        p = _xy(anchor)
        raw = getattr(entity.dxf, "text", None)
        if raw is None:
            raw = getattr(entity, "text", "")
        return MappedEntity(
            "text",
            layer,
            [p],
            z_values=[_z(anchor)],
            metadata={"text": str(raw), "height": float(getattr(entity.dxf, "height", 0.0) or 0.0)},
        )

    if dxf_type == "INSERT":
        p = _xy(entity.dxf.insert)
        return MappedEntity(
            "insert",
            layer,
            [p],
            z_values=[_z(entity.dxf.insert)],
            # Principle P5: the placement, not the exploded geometry. Block definitions are stored
            # once and referenced; resolving them is the block stage's job.
            metadata={
                "block": str(entity.dxf.name),
                "xscale": float(getattr(entity.dxf, "xscale", 1.0) or 1.0),
                "yscale": float(getattr(entity.dxf, "yscale", 1.0) or 1.0),
                "rotation": float(getattr(entity.dxf, "rotation", 0.0) or 0.0),
            },
        )

    if dxf_type in ("SOLID", "3DFACE"):
        pts: list[tuple[float, float]] = []
        for name in ("vtx0", "vtx1", "vtx2", "vtx3"):
            v = getattr(entity.dxf, name, None)
            if v is not None:
                pts.append(_xy(v))
        pts = _dedupe_closing(pts)
        if len(pts) < 3:
            raise MalformedEntity(f"{dxf_type} needs at least 3 distinct vertices, got {len(pts)}")
        return MappedEntity("polygon", layer, pts)

    if dxf_type in ("LWPOLYLINE", "POLYLINE"):
        return _map_polyline(entity, dxf_type, layer, tolerance)

    if dxf_type == "VERTEX":
        return MappedEntity("point", layer, [_xy(entity.dxf.location)])

    raise UnsupportedEntity(dxf_type)


def _map_polyline(entity: Any, dxf_type: str, layer: str, tolerance: float) -> MappedEntity:
    points: list[tuple[float, float]] = []
    bulges: list[float] = []

    if dxf_type == "LWPOLYLINE":
        for item in entity.get_points("xyb"):
            points.append((float(item[0]), float(item[1])))
            bulges.append(float(item[2]) if len(item) > 2 else 0.0)
        closed = bool(getattr(entity, "closed", False) or getattr(entity.dxf, "flags", 0) & 1)
    else:
        for vertex in entity.vertices:
            points.append(_xy(vertex.dxf.location))
            bulges.append(float(getattr(vertex.dxf, "bulge", 0.0) or 0.0))
        closed = bool(getattr(entity, "is_closed", False))

    if len(points) < 2:
        raise MalformedEntity(f"{dxf_type} needs at least 2 vertices, got {len(points)}")

    # Expand bulge segments into arc geometry so curved polylines are not silently straightened.
    expanded: list[tuple[float, float]] = [points[0]]
    span = len(points) if closed else len(points) - 1
    for i in range(span):
        a = points[i]
        b = points[(i + 1) % len(points)]
        bulge = bulges[i] if i < len(bulges) else 0.0
        if bulge:
            try:
                cx, cy, radius, start, end = bulge_to_arc(a, b, bulge)
                arc_points = tessellate_arc(cx, cy, radius, start, end, tolerance)
                if bulge < 0:
                    arc_points.reverse()
                expanded.extend(arc_points[1:])
                continue
            except MalformedEntity:
                # A bad bulge degrades to a straight segment rather than losing the entity.
                pass
        expanded.append(b)

    kind = "polygon" if closed else "polyline"
    if kind == "polygon":
        expanded = _dedupe_closing(expanded)
        if len(expanded) < 3:
            raise MalformedEntity("closed polyline needs at least 3 distinct vertices")

    return MappedEntity(kind, layer, expanded)


def _dedupe_closing(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Drops a repeated final vertex; ring closure is applied once, by the writer."""
    out = list(points)
    while len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def _tessellate_ellipse(
    centre: tuple[float, float],
    major: float,
    minor: float,
    rotation: float,
    start: float,
    end: float,
    segments: int = 64,
) -> list[tuple[float, float]]:
    sweep = end - start
    while sweep <= 0:
        sweep += 2 * math.pi
    cos_r, sin_r = math.cos(rotation), math.sin(rotation)
    points = []
    for i in range(segments + 1):
        t = start + sweep * i / segments
        x, y = major * math.cos(t), minor * math.sin(t)
        points.append((centre[0] + x * cos_r - y * sin_r, centre[1] + x * sin_r + y * cos_r))
    return points


def map_entities(entities: Iterable[Any], report: MappingReport, tolerance: float = DEFAULT_SAGITTA_TOLERANCE):
    """
    Maps a stream of entities, tallying everything that does not map.

    A generator, deliberately: an import must never materialize 10M entities to count them.
    """
    for entity in entities:
        try:
            mapped = map_entity(entity, tolerance)
        except UnsupportedEntity as exc:
            report.record_unsupported(str(exc))
            continue
        except MalformedEntity as exc:
            report.record_failure(
                str(entity.dxftype()), str(exc), getattr(entity.dxf, "handle", None)
            )
            continue
        except Exception as exc:  # noqa: BLE001 - one bad entity must not abort a 10M-entity import
            report.record_failure(
                str(getattr(entity, "dxftype", lambda: "UNKNOWN")()),
                f"{type(exc).__name__}: {exc}",
                getattr(getattr(entity, "dxf", None), "handle", None),
            )
            continue

        report.record_mapped()
        yield mapped
