"""
Import job runner — the queue and the importer joined together.

The interesting part is where the checkpoint is written: inside the importer's per-batch
transaction, via the `on_batch` hook. That is what makes a killed worker safe. The queue's record
of progress and the rows that progress refers to are the same commit, so there is no window in
which one exists without the other.

Reconciliation is enforced here rather than left to a test: a job whose numbers do not add up
fails loudly instead of reporting success over quietly incomplete data.
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
from typing import Optional

import psycopg

from .importer import import_dxf, update_project_extent
from .queue import Job, JobQueue

log = logging.getLogger(__name__)

DEFAULT_SRID = int(os.environ.get("PROJECT_SRID", "32635"))


class ReconciliationError(RuntimeError):
    """Raised when the entities in the file do not account for the rows written."""


def ensure_project(conn: psycopg.Connection, name: str, crs: str) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT create_project(%s, %s)", (name, crs))
        project_id = int(cur.fetchone()[0])
    conn.commit()
    return project_id


def run_import_job(conn: psycopg.Connection, queue: JobQueue, job: Job) -> dict:
    """
    Executes one claimed import job, resuming from its checkpoint if it has one.

    Returns the reconciliation summary. Raises on failure so the caller can record it against the
    job and let the retry policy decide.
    """
    srid = int(job.params.get("srid", DEFAULT_SRID))
    crs = job.params.get("crs", f"EPSG:{srid}")

    project_id = job.project_id
    if project_id is None:
        project_id = ensure_project(conn, job.params.get("name", job.source_uri), crs)
        with conn.cursor() as cur:
            cur.execute("UPDATE import_jobs SET project_id = %s WHERE id = %s", (project_id, job.id))
        conn.commit()

    start_index = int(job.checkpoint.get("imported", 0)) if job.resuming else 0
    if start_index:
        log.info("job %s resuming after %s entities", job.id, f"{start_index:,}")
        queue.log(job.id, f"resuming after {start_index:,} entities", stage="entities")

    def on_batch(imported: int, seen: int, cur: psycopg.Cursor) -> None:
        # Same transaction as the rows: this is the resumability guarantee, not a convenience.
        queue.checkpoint(
            job.id,
            "entities",
            {"imported": start_index + imported, "seen": seen},
            start_index + imported,
            cursor=cur,
        )

    result = import_dxf(
        conn,
        job.source_uri,
        project_id,
        srid,
        start_index=start_index,
        on_batch=on_batch,
    )

    report = result.report
    total_written = start_index + result.imported

    # The contract: everything in the file is written, reported unsupported, or reported failed.
    if not report.reconciles():
        raise ReconciliationError(
            f"entities seen ({report.total}) != mapped ({report.mapped}) "
            f"+ unsupported ({report.unsupported_total}) + failed ({report.failed_total})"
        )

    extent = update_project_extent(conn, project_id)

    unsupported_detail = {**report.unsupported, **{f"{k} (failed)": v for k, v in report.failed.items()}}
    queue.succeed(
        job.id,
        imported=total_written,
        unsupported=report.unsupported_total + report.failed_total,
        unsupported_detail=unsupported_detail,
        total=report.total,
    )
    queue.log(
        job.id,
        f"imported {total_written:,} of {report.total:,} entities",
        stage="done",
        detail={"extent": extent, "degraded": result.degraded, **report.summary()},
    )
    if result.degraded:
        queue.log(
            job.id,
            f"{result.degraded:,} closed rings self-intersected and were stored as linework",
            level="warn",
            stage="done",
        )

    return {
        "project_id": project_id,
        "imported": total_written,
        "seen": report.total,
        "unsupported": report.unsupported_total,
        "failed": report.failed_total,
        "degraded": result.degraded,
        "blocks": result.blocks,
        "instances": result.instances,
        "dangling_instances": result.dangling_instances,
        "extent": extent,
        "memory": result.memory.summary() if result.memory else None,
    }


def run_once(dsn: Optional[str] = None) -> Optional[dict]:
    """Claims and runs a single job. Returns None when the queue is empty."""
    from .queue import connect

    conn = connect(dsn)
    try:
        queue = JobQueue(conn)
        job = queue.claim()
        if job is None:
            return None
        try:
            return run_import_job(conn, queue, job)
        except Exception as exc:  # noqa: BLE001 - recorded against the job, then re-raised
            conn.rollback()
            status = queue.fail(job.id, f"{type(exc).__name__}: {exc}")
            log.exception("job %s failed (now %s)", job.id, status)
            raise
    finally:
        conn.close()
