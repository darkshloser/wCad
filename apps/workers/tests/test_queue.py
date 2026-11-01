"""
Job queue tests, against a real PostgreSQL.

Not mocked. Every property worth testing here — SKIP LOCKED handing a job to exactly one worker,
a checkpoint rolling back with the rows it describes, reclaiming a crashed worker's job — is a
property of the database's concurrency and transaction semantics. A mock would assert only that
the code calls the functions it calls.

Run inside the stack, where DATABASE_URL points at the compose PostGIS:
    docker compose --profile tools run --rm workers pytest
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

import pytest

psycopg = pytest.importorskip("psycopg")

from wcad_workers.queue import JobQueue, connect  # noqa: E402

DSN = os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DSN, reason="DATABASE_URL is not set; run inside the stack (see module docstring)"
)


@pytest.fixture()
def conn():
    c = connect(DSN)
    yield c
    c.close()


@pytest.fixture()
def queue(conn):
    # A pristine queue per test: claiming is global, so a leftover job from another test would be
    # picked up here and make failures depend on execution order.
    with conn.cursor() as cur:
        cur.execute("TRUNCATE job_events, import_jobs RESTART IDENTITY CASCADE")
    conn.commit()
    return JobQueue(conn, worker="test-worker-a")


def test_claiming_an_empty_queue_returns_none(queue):
    assert queue.claim() is None


def test_enqueue_then_claim_round_trips_the_job(queue):
    job_id = queue.enqueue("dxf", "fixtures/tiny.dxf", params={"srid": 32635})

    job = queue.claim()

    assert job is not None
    assert job.id == job_id
    assert job.kind == "dxf"
    assert job.source_uri == "fixtures/tiny.dxf"
    assert job.params == {"srid": 32635}
    assert job.attempts == 1
    assert job.stage == "pending"
    assert not job.resuming


def test_a_claimed_job_is_not_handed_to_a_second_worker(queue, conn):
    queue.enqueue("dxf", "fixtures/tiny.dxf")

    first = queue.claim()

    other_conn = connect(DSN)
    try:
        second = JobQueue(other_conn, worker="test-worker-b").claim()
    finally:
        other_conn.close()

    assert first is not None
    # The core guarantee of SKIP LOCKED: concurrent claimers never collide on the same row.
    assert second is None


def test_two_workers_claiming_two_jobs_get_one_each(queue):
    queue.enqueue("dxf", "a.dxf")
    queue.enqueue("dxf", "b.dxf")

    other_conn = connect(DSN)
    try:
        first = queue.claim()
        second = JobQueue(other_conn, worker="test-worker-b").claim()
    finally:
        other_conn.close()

    assert first is not None and second is not None
    assert first.id != second.id


def test_priority_orders_the_queue_ahead_of_insertion_order(queue):
    queue.enqueue("dxf", "normal.dxf", priority=100)
    urgent = queue.enqueue("dxf", "urgent.dxf", priority=1)

    assert queue.claim().id == urgent


def test_a_crashed_workers_job_is_reclaimed_once_its_heartbeat_goes_stale(queue, conn):
    queue.enqueue("dxf", "fixtures/tiny.dxf")
    first = queue.claim()
    assert first is not None

    # Still running and heartbeating: must not be stolen.
    assert queue.claim() is None

    # Simulate the worker dying: the heartbeat stops advancing.
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE import_jobs SET heartbeat_at = now() - interval '5 minutes' WHERE id = %s",
            (first.id,),
        )
    conn.commit()

    reclaimed = queue.claim()

    assert reclaimed is not None
    assert reclaimed.id == first.id
    assert reclaimed.attempts == 2


def test_checkpoint_records_resumable_progress(queue):
    job_id = queue.enqueue("dxf", "fixtures/small.dxf")
    queue.claim()

    queue.checkpoint(job_id, "entities", {"offset": 40_000}, 40_000)

    row = queue.get(job_id)
    assert row["stage"] == "entities"
    assert row["checkpoint"] == {"offset": 40_000}
    assert row["entities_imported"] == 40_000


def test_a_resumed_job_reports_its_last_checkpoint(queue, conn):
    job_id = queue.enqueue("dxf", "fixtures/small.dxf")
    queue.claim()
    queue.checkpoint(job_id, "entities", {"offset": 40_000}, 40_000)

    with conn.cursor() as cur:
        cur.execute(
            "UPDATE import_jobs SET heartbeat_at = now() - interval '5 minutes' WHERE id = %s",
            (job_id,),
        )
    conn.commit()

    resumed = queue.claim()

    assert resumed is not None
    assert resumed.resuming
    assert resumed.checkpoint == {"offset": 40_000}
    assert resumed.entities_imported == 40_000


def test_a_rolled_back_batch_takes_its_checkpoint_with_it(queue, conn):
    """
    The property the whole design rests on.

    A checkpoint written in the same transaction as the rows it describes cannot survive a crash
    that loses those rows. If this fails, a resumed import skips data and reconciliation breaks.
    """
    job_id = queue.enqueue("dxf", "fixtures/small.dxf")
    queue.claim()
    queue.checkpoint(job_id, "entities", {"offset": 10_000}, 10_000)

    with conn.cursor() as cur:
        cur.execute("SELECT create_project(%s, %s)", ("queue-atomicity", "EPSG:32635"))
        cur.execute(
            "SELECT id FROM projects WHERE name = %s ORDER BY id DESC LIMIT 1",
            ("queue-atomicity",),
        )
        project_id = cur.fetchone()[0]
    conn.commit()

    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO layers (project_id, name) VALUES (%s, %s) RETURNING id",
                (project_id, "L0"),
            )
            layer_id = cur.fetchone()[0]
            cur.execute(
                """
                INSERT INTO elements
                    (project_id, layer_id, kind, srid, geom, bbox, bbox_diag)
                VALUES (%s, %s, 1, 32635,
                        ST_GeomFromText('POINT(500000 4650000)', 32635),
                        Box2D(ST_GeomFromText('POINT(500000 4650000)', 32635)), 0)
                """,
                (project_id, layer_id),
            )
            # Advance the checkpoint alongside the write, then abandon both.
            queue.checkpoint(job_id, "entities", {"offset": 20_000}, 20_000, cursor=cur)
            conn.rollback()

        row = queue.get(job_id)
        assert row["checkpoint"] == {"offset": 10_000}, "checkpoint outlived the rows it described"
        assert row["entities_imported"] == 10_000

        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM elements WHERE project_id = %s", (project_id,))
            assert cur.fetchone()[0] == 0
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM projects WHERE id = %s", (project_id,))
        conn.commit()


def test_failure_requeues_until_attempts_are_exhausted_then_dead_letters(queue):
    job_id = queue.enqueue("dxf", "broken.dxf")

    queue.claim()
    assert queue.fail(job_id, "first failure") == "queued"

    queue.claim()
    assert queue.fail(job_id, "second failure") == "queued"

    queue.claim()
    assert queue.fail(job_id, "third failure") == "dead"

    # A dead job is out of the rotation but fully inspectable.
    assert queue.claim() is None
    row = queue.get(job_id)
    assert row["status"] == "dead"
    assert len(row["errors"]) == 3
    assert row["errors"][0]["error"] == "first failure"


def test_success_records_the_reconciliation_counts(queue):
    job_id = queue.enqueue("dxf", "fixtures/tiny.dxf")
    queue.claim()

    queue.succeed(
        job_id,
        imported=98,
        unsupported=2,
        unsupported_detail={"3DSOLID": 2},
        total=100,
    )

    row = queue.get(job_id)
    assert row["status"] == "succeeded"
    assert row["entities_imported"] == 98
    assert row["entities_unsupported"] == 2
    assert row["unsupported_detail"] == {"3DSOLID": 2}
    # The reconciliation identity itself: nothing may go missing silently.
    assert row["entities_imported"] + row["entities_unsupported"] == row["entities_total"]
    assert queue.claim() is None


def test_events_are_appended_for_operators(queue):
    job_id = queue.enqueue("dxf", "fixtures/tiny.dxf")
    queue.claim()

    queue.log(job_id, "started", stage="entities")
    queue.log(job_id, "unsupported entity", level="warn", detail={"type": "3DSOLID"})

    row = queue.get(job_id)
    assert row is not None
    with queue._conn.cursor() as cur:  # noqa: SLF001 - inspecting the log is the point of the test
        cur.execute("SELECT level, message FROM job_events WHERE job_id = %s ORDER BY id", (job_id,))
        events = cur.fetchall()

    assert [e[0] for e in events] == ["info", "warn"]
    assert events[1][1] == "unsupported entity"


def test_pending_count_reflects_the_queue(queue):
    assert queue.pending_count() == 0
    queue.enqueue("dxf", "a.dxf")
    queue.enqueue("dxf", "b.dxf")
    assert queue.pending_count() == 2

    queue.claim()
    assert queue.pending_count() == 1
