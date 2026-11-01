"""
Block placement maths, without a database.

Separated from test_blocks.py so these run everywhere and fast. The database-backed suite proves
this agrees with PostGIS's ST_Affine; this one proves the maths is right in the first place, and
gives the quick signal when a transform is edited.
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

from wcad_workers.blocks import (
    BlockDefinition,
    apply_transform,
    definition_bbox,
    insert_transform,
    transformed_bbox,
)
from wcad_workers.entities import MappedEntity


def test_an_untransformed_insert_is_a_pure_translation():
    transform = insert_transform((100.0, 200.0), (0.0, 0.0), 1.0, 1.0, 0.0)

    assert apply_transform(transform, (0.0, 0.0)) == (100.0, 200.0)
    assert apply_transform(transform, (1.0, 0.0)) == (101.0, 200.0)


def test_rotation_turns_the_symbol_the_right_way():
    transform = insert_transform((0.0, 0.0), (0.0, 0.0), 1.0, 1.0, 90.0)

    x, y = apply_transform(transform, (1.0, 0.0))

    # Counter-clockwise, as DXF rotation is defined. A sign error here mirrors every symbol.
    assert math.isclose(x, 0.0, abs_tol=1e-9)
    assert math.isclose(y, 1.0, abs_tol=1e-9)


def test_scale_is_applied_before_rotation():
    """
    Order matters, and only shows up when the two scales differ.

    Rotating before scaling shears the symbol. With equal scales the two orders give identical
    results, so a drawing full of uniformly scaled blocks hides the bug completely.
    """
    transform = insert_transform((0.0, 0.0), (0.0, 0.0), 2.0, 3.0, 90.0)

    x1, y1 = apply_transform(transform, (1.0, 0.0))
    x2, y2 = apply_transform(transform, (0.0, 1.0))

    assert math.isclose(x1, 0.0, abs_tol=1e-9) and math.isclose(y1, 2.0, abs_tol=1e-9)
    assert math.isclose(x2, -3.0, abs_tol=1e-9) and math.isclose(y2, 0.0, abs_tol=1e-9)


def test_a_block_lands_where_its_insertion_point_says():
    """The base point maps onto the insertion point — the placement rule every CAD user relies on."""
    base = (10.0, 20.0)
    insert_point = (500_123.5, 4_650_321.25)
    transform = insert_transform(insert_point, base, 1.0, 1.0, 37.0)

    placed = apply_transform(transform, base)

    assert math.isclose(placed[0], insert_point[0], abs_tol=1e-9)
    assert math.isclose(placed[1], insert_point[1], abs_tol=1e-9)


def test_placement_holds_at_projected_magnitudes():
    # Where float64 cancellation actually bites: a symbol placed 4.6 million metres from the origin.
    base = (-5.5, 7.25)
    insert_point = (500_123.45678901234, 4_650_321.104567891)
    transform = insert_transform(insert_point, base, 0.5, 0.5, 200.0)

    placed = apply_transform(transform, base)

    assert math.isclose(placed[0], insert_point[0], abs_tol=1e-6)
    assert math.isclose(placed[1], insert_point[1], abs_tol=1e-6)


def test_definition_bbox_covers_every_member_entity():
    """A bbox taken from only the first entity would clip multi-part symbols."""
    definition = BlockDefinition(
        name="TWO_PART",
        base_point=(0.0, 0.0),
        entities=[
            MappedEntity(kind="line", layer="0", coords=[(0.0, 0.0), (1.0, 1.0)]),
            MappedEntity(kind="line", layer="0", coords=[(-5.0, -5.0), (0.0, 0.0)]),
        ],
    )

    assert definition_bbox(definition) == (-5.0, -5.0, 1.0, 1.0)


def test_an_empty_definition_has_no_bbox():
    assert definition_bbox(BlockDefinition(name="EMPTY", base_point=(0.0, 0.0))) is None


def test_rotated_extent_uses_every_corner():
    """
    A rotated rectangle's extent is set by whichever corners end up furthest apart.

    Transforming only the min and max corner is the natural shortcut and is quietly wrong: for a
    10x2 rectangle at 45 degrees it understates the x range by more than a metre, and an instance
    with an understated extent is culled from tiles it belongs in.
    """
    box = (0.0, 0.0, 10.0, 2.0)
    transform = insert_transform((0.0, 0.0), (0.0, 0.0), 1.0, 1.0, 45.0)

    min_x, _min_y, _max_x, max_y = transformed_bbox(box, transform)

    naive = [apply_transform(transform, (0.0, 0.0)), apply_transform(transform, (10.0, 2.0))]
    assert min_x < min(c[0] for c in naive), "the shortcut would have clipped the left edge"
    assert math.isclose(min_x, -math.sqrt(2), abs_tol=1e-9)
    assert max_y > 8.0


def test_an_unrotated_extent_is_just_the_scaled_box():
    box = (0.0, 0.0, 10.0, 2.0)
    transform = insert_transform((100.0, 100.0), (0.0, 0.0), 2.0, 2.0, 0.0)

    assert transformed_bbox(box, transform) == (100.0, 100.0, 120.0, 104.0)
