"""
Schema migration runner.

`docker/postgis/init.sql` only ever executes on an empty data directory — PostgreSQL skips
docker-entrypoint-initdb.d entirely once a database exists. Every schema change after the first
therefore has to reach existing databases some other way, and until now there was none: editing
init.sql changed nothing for anyone who already had data, which is precisely how a schema change
silently fails to reach the machines that matter.

Rules this follows:

  * One file, one version, applied once, recorded in `schema_migrations`.
  * Each migration runs inside its own transaction. PostgreSQL supports transactional DDL, so a
    migration that fails halfway leaves nothing behind — no half-migrated schema to unpick by hand.
  * Ordering is lexicographic by filename, which is why they are zero-padded.
  * Applying is idempotent: running it twice is a no-op, so `up` can run it unconditionally.
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
import os
import sys
from pathlib import Path
from typing import Optional

import psycopg

log = logging.getLogger(__name__)

# Mounted read-only into the workers container; see docker-compose.yml.
DEFAULT_MIGRATIONS_DIR = Path(os.environ.get("WCAD_MIGRATIONS", "/migrations"))

BASELINE = "000_baseline"


def find_migrations_dir(explicit: Optional[Path] = None) -> Optional[Path]:
    """Locates the migrations directory in both the container and a repo checkout."""
    candidates = [explicit] if explicit else []
    candidates.append(DEFAULT_MIGRATIONS_DIR)
    here = Path(__file__).resolve()
    candidates.extend(p / "docker" / "postgis" / "migrations" for p in here.parents)

    for candidate in candidates:
        if candidate and candidate.is_dir():
            return candidate
    return None


def ensure_migrations_table(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version    text        PRIMARY KEY,
              applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        # A database created before this runner existed has the baseline schema but no record of
        # it. Detect that by looking for a table the baseline creates, rather than re-running it.
        cur.execute("SELECT to_regclass('public.elements') IS NOT NULL")
        has_baseline_schema = bool(cur.fetchone()[0])
        if has_baseline_schema:
            cur.execute(
                "INSERT INTO schema_migrations (version) VALUES (%s) ON CONFLICT DO NOTHING",
                (BASELINE,),
            )
    conn.commit()


def applied_versions(conn: psycopg.Connection) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations")
        return {row[0] for row in cur.fetchall()}


def pending(conn: psycopg.Connection, directory: Path) -> list[Path]:
    done = applied_versions(conn)
    files = sorted(p for p in directory.glob("*.sql") if p.is_file())
    return [p for p in files if p.stem not in done]


def apply(conn: psycopg.Connection, path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
        cur.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.stem,))
    # The migration and its record commit together: a migration can never be applied without being
    # recorded, nor recorded without being applied.
    conn.commit()


def migrate(dsn: Optional[str] = None, directory: Optional[Path] = None) -> int:
    resolved_dir = find_migrations_dir(directory)
    if resolved_dir is None:
        log.error("no migrations directory found (set WCAD_MIGRATIONS)")
        return 2

    conn = psycopg.connect(dsn or os.environ["DATABASE_URL"])
    try:
        ensure_migrations_table(conn)
        todo = pending(conn, resolved_dir)

        if not todo:
            log.info("schema up to date (%s applied)", len(applied_versions(conn)))
            return 0

        for path in todo:
            log.info("applying %s", path.stem)
            try:
                apply(conn, path)
            except Exception:
                conn.rollback()
                log.exception("migration %s failed; nothing from it was applied", path.stem)
                return 1

        log.info("applied %s migration(s)", len(todo))
        return 0
    finally:
        conn.close()


def status(dsn: Optional[str] = None, directory: Optional[Path] = None) -> int:
    resolved_dir = find_migrations_dir(directory)
    conn = psycopg.connect(dsn or os.environ["DATABASE_URL"])
    try:
        ensure_migrations_table(conn)
        done = applied_versions(conn)
        files = sorted(p.stem for p in resolved_dir.glob("*.sql")) if resolved_dir else []

        print(f"{'version':<32} {'status'}")
        for version in [BASELINE, *files]:
            print(f"  {version:<30} {'applied' if version in done else 'PENDING'}")
        orphaned = done - {BASELINE, *files}
        for version in sorted(orphaned):
            print(f"  {version:<30} applied, file missing")
        return 0
    finally:
        conn.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [migrate] %(message)s")
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        sys.exit(status())
    sys.exit(migrate())


if __name__ == "__main__":
    main()
