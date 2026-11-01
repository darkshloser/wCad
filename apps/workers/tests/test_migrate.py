"""
Migration runner tests, against real PostgreSQL.

Transactional DDL is the property that matters here and it is a database behaviour, so these run
against the real thing. A migration that fails halfway must leave nothing behind — including its
own version record.
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

import pytest

psycopg = pytest.importorskip("psycopg")

from wcad_workers.migrate import (  # noqa: E402
    BASELINE,
    applied_versions,
    apply,
    ensure_migrations_table,
    find_migrations_dir,
    pending,
)
from wcad_workers.queue import connect  # noqa: E402

DSN = os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(not DSN, reason="DATABASE_URL is not set; run inside the stack")


@pytest.fixture()
def conn():
    c = connect(DSN)
    yield c
    c.close()


def test_the_repo_migrations_are_all_applied(conn):
    """After `up`, nothing should be outstanding — that is what makes `up` trustworthy."""
    directory = find_migrations_dir()
    assert directory is not None, "migrations directory not found"

    ensure_migrations_table(conn)
    assert pending(conn, directory) == [], "run `wcad.ps1 migrate`"


def test_the_baseline_is_recorded(conn):
    ensure_migrations_table(conn)
    # Either init.sql recorded it, or the runner detected an existing schema and backfilled it.
    assert BASELINE in applied_versions(conn)


def test_migration_filenames_sort_in_application_order():
    directory = find_migrations_dir()
    names = sorted(p.stem for p in directory.glob("*.sql"))
    for name in names:
        prefix = name.split("_", 1)[0]
        # Zero-padded, because lexicographic order IS the application order: "10" must not sort
        # before "9".
        assert prefix.isdigit() and len(prefix) == 3, f"{name} must start with a 3-digit version"


def test_block_geometry_migration_produced_the_expected_shape(conn):
    """001 is what unblocks instancing, so assert the shape it promises rather than trusting it."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, udt_name FROM information_schema.columns
             WHERE table_name = 'block_definitions'
            """
        )
        columns = {r[0]: r[1] for r in cur.fetchall()}

    assert "geometry" in columns, "block definitions need real PostGIS geometry"
    assert columns["geometry"] == "geometry"
    assert "base_point" in columns
    # The opaque blob it replaced must be gone, or two sources of truth exist.
    assert "geometry_blob" not in columns


def test_a_failing_migration_leaves_nothing_behind(conn, tmp_path: Path):
    """
    Transactional DDL, verified rather than assumed.

    A migration that creates a table and then fails must leave neither the table nor its version
    record — otherwise the next run skips it and the schema is permanently half-applied.
    """
    ensure_migrations_table(conn)

    broken = tmp_path / "999_broken.sql"
    broken.write_text(
        "CREATE TABLE wcad_migration_probe (id int);\n"
        "SELECT this_function_does_not_exist();\n",
        encoding="utf-8",
    )

    with pytest.raises(Exception):
        apply(conn, broken)
    conn.rollback()

    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.wcad_migration_probe') IS NULL")
        table_gone = bool(cur.fetchone()[0])

    assert table_gone, "a failed migration left a table behind"
    assert "999_broken" not in applied_versions(conn), "a failed migration was recorded as applied"


def test_applying_is_idempotent(conn, tmp_path: Path):
    ensure_migrations_table(conn)

    once = tmp_path / "998_probe.sql"
    once.write_text("CREATE TABLE IF NOT EXISTS wcad_migration_probe2 (id int);\n", encoding="utf-8")

    try:
        apply(conn, once)
        assert "998_probe" in applied_versions(conn)
        # Already applied, so it is no longer pending — `up` can run migrate unconditionally.
        assert once not in pending(conn, tmp_path)
    finally:
        with conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS wcad_migration_probe2")
            cur.execute("DELETE FROM schema_migrations WHERE version = '998_probe'")
        conn.commit()
