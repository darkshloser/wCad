"""
PostgreSQL-backed job queue client.

The queue lives in the same database as the imported rows, which is the whole point: a stage
checkpoint and the batch of elements it describes commit in ONE transaction. A worker killed
mid-import therefore rolls back to a state where the queue and the data agree by construction,
rather than leaving them to be reconciled afterwards.

Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED` (see claim_import_job in init.sql), so any
number of workers can claim concurrently without blocking each other and without two of them ever
receiving the same job.
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
import os
import socket
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional

import psycopg
from psycopg.rows import dict_row

# A job whose worker has not heartbeated within this window is considered crashed and may be
# reclaimed. Long enough that a slow COPY batch is never mistaken for a dead worker.
STALE_AFTER_SECONDS = 60

# Terminal stage name, recorded when a job finishes successfully.
STAGE_DONE = "done"


@dataclass(frozen=True)
class Job:
    """One unit of import work, as claimed from the queue."""

    id: int
    project_id: Optional[int]
    kind: str
    source_uri: str
    params: dict[str, Any] = field(default_factory=dict)
    stage: str = "pending"
    checkpoint: dict[str, Any] = field(default_factory=dict)
    attempts: int = 0
    max_attempts: int = 3
    entities_imported: int = 0

    @property
    def resuming(self) -> bool:
        """True when this claim is a restart of work that already made progress."""
        return self.attempts > 1 and self.stage != "pending"


def worker_name() -> str:
    """Identifies the claiming process in the queue, for operators reading `claimed_by`."""
    return f"{socket.gethostname()}/{os.getpid()}"


class JobQueue:
    """
    Thin client over the queue tables.

    Deliberately does not hold a long-lived transaction open between calls: a worker importing for
    twenty minutes must not pin one transaction for that whole time, or vacuum cannot reclaim
    anything and the database bloats. Each call commits.
    """

    def __init__(self, conn: psycopg.Connection, worker: Optional[str] = None) -> None:
        self._conn = conn
        self._worker = worker or worker_name()

    @property
    def worker(self) -> str:
        return self._worker

    def enqueue(
        self,
        kind: str,
        source_uri: str,
        *,
        project_id: Optional[int] = None,
        params: Optional[dict[str, Any]] = None,
        priority: int = 100,
        source_sha256: Optional[str] = None,
        source_bytes: Optional[int] = None,
    ) -> int:
        with self._conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO import_jobs
                    (project_id, kind, source_uri, params, priority, source_sha256, source_bytes)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    project_id,
                    kind,
                    source_uri,
                    json.dumps(params or {}),
                    priority,
                    source_sha256,
                    source_bytes,
                ),
            )
            row = cur.fetchone()
        self._conn.commit()
        return int(row[0])

    def claim(self, stale_after_seconds: int = STALE_AFTER_SECONDS) -> Optional[Job]:
        """Claims one job, or returns None when the queue is empty."""
        with self._conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT * FROM claim_import_job(%s, make_interval(secs => %s))",
                (self._worker, stale_after_seconds),
            )
            row = cur.fetchone()
        self._conn.commit()

        # The function returns a NULL composite when nothing was claimable.
        if row is None or row.get("id") is None:
            return None

        return Job(
            id=row["id"],
            project_id=row["project_id"],
            kind=row["kind"],
            source_uri=row["source_uri"],
            params=row["params"] or {},
            stage=row["stage"],
            checkpoint=row["checkpoint"] or {},
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
            entities_imported=row["entities_imported"],
        )

    def checkpoint(
        self,
        job_id: int,
        stage: str,
        checkpoint: dict[str, Any],
        imported: int,
        *,
        cursor: Optional[psycopg.Cursor] = None,
    ) -> None:
        """
        Records resumable progress.

        Pass `cursor` to enrol this in the caller's open transaction — that is the mechanism that
        keeps the checkpoint and the rows it describes atomic. Called without one it commits on
        its own, which is only correct for progress that does not accompany a write.
        """
        sql = "SELECT checkpoint_import_job(%s, %s, %s, %s)"
        args = (job_id, stage, json.dumps(checkpoint), imported)

        if cursor is not None:
            cursor.execute(sql, args)
            return

        with self._conn.cursor() as cur:
            cur.execute(sql, args)
        self._conn.commit()

    def heartbeat(self, job_id: int) -> None:
        """Signals liveness so the job is not reclaimed as crashed."""
        with self._conn.cursor() as cur:
            cur.execute("UPDATE import_jobs SET heartbeat_at = now() WHERE id = %s", (job_id,))
        self._conn.commit()

    def log(
        self,
        job_id: int,
        message: str,
        *,
        level: str = "info",
        stage: Optional[str] = None,
        detail: Optional[dict[str, Any]] = None,
    ) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "INSERT INTO job_events (job_id, level, stage, message, detail) VALUES (%s, %s, %s, %s, %s)",
                (job_id, level, stage, message, json.dumps(detail) if detail is not None else None),
            )
        self._conn.commit()

    def succeed(
        self,
        job_id: int,
        *,
        imported: int,
        unsupported: int = 0,
        unsupported_detail: Optional[dict[str, int]] = None,
        total: Optional[int] = None,
    ) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                """
                UPDATE import_jobs
                   SET status = 'succeeded',
                       stage = %s,
                       entities_imported = %s,
                       entities_unsupported = %s,
                       unsupported_detail = %s,
                       entities_total = COALESCE(%s, entities_total),
                       finished_at = now(),
                       heartbeat_at = now()
                 WHERE id = %s
                """,
                (
                    STAGE_DONE,
                    imported,
                    unsupported,
                    json.dumps(unsupported_detail or {}),
                    total,
                    job_id,
                ),
            )
        self._conn.commit()

    def fail(self, job_id: int, error: str, *, detail: Optional[dict[str, Any]] = None) -> str:
        """
        Records a failure and decides whether the job retries.

        Returns the resulting status: 'queued' when attempts remain, 'dead' once they are
        exhausted. A dead job keeps its checkpoint and error history — the point of a dead-letter
        state is to be inspected, not to disappear.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                """
                UPDATE import_jobs
                   SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
                       errors = errors || %s::jsonb,
                       claimed_by = NULL,
                       claimed_at = NULL,
                       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
                 WHERE id = %s
                 RETURNING status
                """,
                (json.dumps([{"error": error, "detail": detail or {}}]), job_id),
            )
            status = cur.fetchone()[0]
        self._conn.commit()

        self.log(job_id, error, level="error", detail=detail)
        return str(status)

    def get(self, job_id: int) -> Optional[dict[str, Any]]:
        with self._conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT * FROM import_jobs WHERE id = %s", (job_id,))
            return cur.fetchone()

    def pending_count(self) -> int:
        with self._conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM import_jobs WHERE status = 'queued'")
            return int(cur.fetchone()[0])


def connect(dsn: Optional[str] = None) -> psycopg.Connection:
    """Opens a connection using DATABASE_URL unless a DSN is given."""
    resolved = dsn or os.environ.get("DATABASE_URL")
    if not resolved:
        raise RuntimeError("DATABASE_URL is not set and no DSN was provided")
    return psycopg.connect(resolved)


def iter_jobs(queue: JobQueue, limit: Optional[int] = None) -> Iterator[Job]:
    """Yields claimable jobs until the queue drains, or `limit` jobs have been handled."""
    handled = 0
    while limit is None or handled < limit:
        job = queue.claim()
        if job is None:
            return
        handled += 1
        yield job
