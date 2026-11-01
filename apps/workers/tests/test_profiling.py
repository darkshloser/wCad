"""
Memory profiling tests.

The profiler exists to catch a buffering regression in the importer, so the thing worth testing is
that it actually distinguishes flat memory from growing memory — a leak detector that never fires
is worse than none, because it is believed.
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

from wcad_workers.profiling import (
    MemoryProfile,
    MemorySample,
    format_bytes,
    peak_rss_bytes,
    rss_bytes,
)


def profile_from(values: list[int]) -> MemoryProfile:
    """Builds a profile from known RSS values, so the assertions are about the maths."""
    p = MemoryProfile()
    p.samples = [MemorySample(processed=i * 1000, rss=v) for i, v in enumerate(values)]
    return p


MB = 1024 * 1024


def test_rss_is_a_plausible_positive_number():
    current = rss_bytes()
    assert current > 0
    # A Python process is never 100 GB, and a zero would silently disable every budget check.
    assert current < 100 * 1024 * MB
    assert peak_rss_bytes() > 0


def test_flat_memory_reads_as_flat():
    profile = profile_from([200 * MB] * 40)

    assert profile.growth_ratio() == 1.0
    assert profile.growth_bytes() == 0


def test_sawtooth_from_garbage_collection_is_not_a_leak():
    # Real processes oscillate as garbage is collected; comparing quarter means rather than
    # first-to-last is what makes that survivable.
    values = [(200 + (i % 5) * 10) * MB for i in range(40)]
    profile = profile_from(values)

    assert profile.growth_ratio() is not None
    assert abs(profile.growth_ratio() - 1.0) < 0.1


def test_steady_growth_is_detected():
    # The signature of buffering: RSS tracks the entity count.
    values = [(100 + i * 10) * MB for i in range(40)]
    profile = profile_from(values)

    assert profile.growth_ratio() > 2.0
    assert profile.growth_bytes() > 200 * MB


def test_a_single_early_spike_is_not_reported_as_growth():
    # Loading a font table or a projection database allocates once and stays flat afterwards.
    values = [500 * MB] + [200 * MB] * 39
    profile = profile_from(values)

    assert profile.growth_ratio() < 1.0, "memory settled; that is not growth"
    assert profile.peak == 500 * MB, "the spike is still visible in the peak"


def test_too_few_samples_reports_nothing_rather_than_guessing():
    profile = profile_from([100 * MB] * 4)

    assert profile.growth_ratio() is None
    assert profile.growth_bytes() is None
    # The summary must still be renderable, so a short import does not crash the reporter.
    assert profile.summary()["growth_ratio"] is None


def test_sampling_is_bounded_but_keeps_the_end_of_the_run():
    """
    A 10M-entity import must not turn the profiler into the leak it is looking for.

    Halving resolution rather than dropping the tail matters: growth shows at the end of a run, so
    discarding late samples would hide exactly what this is for.
    """
    profile = MemoryProfile(max_samples=100)
    for i in range(1000):
        profile.record(i * 10_000)

    assert len(profile.samples) <= 200
    # The most recent batch is still represented.
    assert profile.samples[-1].processed == 999 * 10_000


def test_summary_is_serialisable_for_the_job_log():
    profile = profile_from([(100 + i) * MB for i in range(40)])
    summary = profile.summary()

    assert set(summary) == {"samples", "peak_mb", "first_mb", "last_mb", "growth_ratio", "growth_mb"}
    for value in summary.values():
        assert isinstance(value, (int, float)), "job detail must be JSON-friendly"


def test_format_bytes_switches_units_where_a_human_would():
    assert format_bytes(512 * MB) == "512 MiB"
    assert format_bytes(2 * 1024 * MB) == "2.00 GiB"
