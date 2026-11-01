"""
Worker entry point.

Two modes:

  worker  — poll the queue and run import jobs until stopped (the compose `workers` service)
  import  — enqueue a file and run it immediately, for operators and for the dev loop

Polling rather than LISTEN/NOTIFY: imports are minutes long and arrive at human frequency, so a
one-second poll costs nothing measurable and removes a whole class of missed-notification bugs.
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

import argparse
import logging
import os
import signal
import sys
import time
import urllib.request

logging.basicConfig(level=logging.INFO, format="%(asctime)s [worker] %(message)s")
log = logging.getLogger(__name__)

POLL_SECONDS = 1.0

_stopping = False


def _stop(signum, _frame) -> None:
    global _stopping
    _stopping = True
    log.info("signal %s received; finishing the current job before exiting", signum)


def refresh_tile_service() -> None:
    """Tells the tile service to re-read project extents after an import changes them."""
    url = os.environ.get("TILES_URL")
    if not url:
        return
    try:
        with urllib.request.urlopen(f"{url}/admin/refresh", timeout=5) as resp:
            resp.read()
        log.info("tile service project cache refreshed")
    except Exception as exc:  # noqa: BLE001 - a cache refresh must never fail an import
        log.warning("could not refresh the tile service: %s", exc)


def run_worker() -> int:
    from .import_job import run_once

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log.info("worker ready; polling for import jobs")
    idle_logged = False

    while not _stopping:
        try:
            result = run_once()
        except Exception:  # noqa: BLE001 - already recorded against the job; keep the worker alive
            log.exception("job failed; continuing")
            time.sleep(POLL_SECONDS)
            continue

        if result is None:
            if not idle_logged:
                log.info("queue empty; waiting")
                idle_logged = True
            time.sleep(POLL_SECONDS)
            continue

        idle_logged = False
        log.info(
            "imported %s entities into project %s (%s unsupported, %s failed)",
            f"{result['imported']:,}",
            result["project_id"],
            result["unsupported"],
            result["failed"],
        )
        refresh_tile_service()

    log.info("worker stopped")
    return 0


"""Phase 3 import budgets (IMPLEMENTATION-PLAN.md section 7), asserted rather than described."""
BUDGET_SECONDS = 15 * 60
BUDGET_PEAK_MB = 2048
# Flat means flat: a streaming importer's resident set should not track the entity count. Both
# thresholds must be exceeded to fail, because a ratio alone misjudges small processes and an
# absolute alone misjudges large ones.
BUDGET_GROWTH_RATIO = 1.5
BUDGET_GROWTH_MB = 256


def _report_budgets(result: dict, elapsed: float) -> int:
    """Prints the Phase 3 import budgets as pass/fail. Returns the number missed."""
    memory = result.get("memory") or {}
    peak = memory.get("peak_mb")
    ratio = memory.get("growth_ratio")
    growth = memory.get("growth_mb")

    print("\nbudgets")
    failed = 0

    ok = elapsed <= BUDGET_SECONDS
    failed += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  {'Import duration':<28} {elapsed / 60:7.1f} min  (budget <= {BUDGET_SECONDS // 60} min)")

    if peak is None:
        print(f"  SKIP  {'Peak memory':<28} {'not measured':>12}")
        failed += 1
    else:
        ok = peak <= BUDGET_PEAK_MB
        failed += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'}  {'Peak memory':<28} {peak:7.0f} MB   (budget <= {BUDGET_PEAK_MB} MB)")

    if ratio is None or growth is None:
        print(f"  SKIP  {'Memory stays flat':<28} {'too few samples':>12}")
    else:
        leaked = ratio > BUDGET_GROWTH_RATIO and growth > BUDGET_GROWTH_MB
        failed += 1 if leaked else 0
        print(
            f"  {'FAIL' if leaked else 'PASS'}  {'Memory stays flat':<28} "
            f"{ratio:7.2f}x     (+{growth:.0f} MB; fails above {BUDGET_GROWTH_RATIO}x and {BUDGET_GROWTH_MB} MB)"
        )

    reconciled = result["imported"] + result["unsupported"] + result["failed"] == result["seen"]
    failed += 0 if reconciled else 1
    print(f"  {'PASS' if reconciled else 'FAIL'}  {'Reconciliation exact':<28} {result['imported']:>12,}")

    return failed


def run_import(path: str, name: str | None, srid: int, budgets: bool = False) -> int:
    """Enqueues one file and runs it in the foreground, reporting reconciliation."""
    from .import_job import run_import_job
    from .queue import JobQueue, connect

    if not os.path.exists(path):
        log.error("no such file: %s", path)
        return 2

    conn = connect()
    try:
        queue = JobQueue(conn)
        job_id = queue.enqueue(
            "dxf",
            path,
            params={"srid": srid, "name": name or f"import:{os.path.basename(path)}"},
            source_bytes=os.path.getsize(path),
        )
        log.info("queued job %s for %s", job_id, path)

        job = queue.claim()
        if job is None or job.id != job_id:
            log.error("another worker claimed job %s first", job_id)
            return 1

        started = time.time()
        result = run_import_job(conn, queue, job)
        elapsed = time.time() - started

        log.info(
            "imported %s of %s entities in %.1fs (%s unsupported, %s failed)",
            f"{result['imported']:,}",
            f"{result['seen']:,}",
            elapsed,
            result["unsupported"],
            result["failed"],
        )
        log.info("extent %s", result["extent"])
        if result.get("blocks"):
            log.info(
                "%s block definitions, %s instances (%s dangling)",
                f"{result['blocks']:,}",
                f"{result['instances']:,}",
                f"{result['dangling_instances']:,}",
            )
        if result.get("memory"):
            m = result["memory"]
            log.info(
                "memory: peak %s MB, %s -> %s MB over %s samples",
                m["peak_mb"], m["first_mb"], m["last_mb"], m["samples"],
            )

        row = queue.get(job_id)
        if row and row["unsupported_detail"]:
            log.info("not imported, by type:")
            for kind, count in sorted(row["unsupported_detail"].items(), key=lambda kv: -kv[1]):
                log.info("  %-24s %s", kind, f"{count:,}")

        refresh_tile_service()
        web = os.environ.get("WEB_URL", "http://localhost:5173")
        log.info("project id %s — open %s/?project=%s", result["project_id"], web, result["project_id"])

        if budgets:
            missed = _report_budgets(result, elapsed)
            print("\nAll budgets met." if missed == 0 else f"\n{missed} budget(s) missed.")
            return 0 if missed == 0 else 1
        return 0
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="wcad-workers")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("worker", help="poll the queue and run import jobs")

    imp = sub.add_parser("import", help="import one file now")
    imp.add_argument("--file", required=True)
    imp.add_argument("--name", default=None)
    imp.add_argument("--srid", type=int, default=int(os.environ.get("PROJECT_SRID", "32635")))
    imp.add_argument(
        "--budgets",
        action="store_true",
        help="assert the Phase 3 import budgets and exit non-zero if any is missed",
    )

    args = parser.parse_args()

    if args.command == "import":
        sys.exit(run_import(args.file, args.name, args.srid, budgets=args.budgets))
    sys.exit(run_worker())


if __name__ == "__main__":
    main()
