"""
Memory profiling for the import path.

"Streaming" is a claim, and claims about memory are worth exactly as much as the measurement
behind them. A 10M-entity import must run in the same memory as a 10k-entity one; a resident set
that climbs with the entity count means something is accumulating — a list that is appended to and
never cleared, a cache keyed by entity id, a generator quietly turned into a list by a `sorted()`
somewhere.

That failure is invisible on small fixtures and fatal on real ones, and it does not announce
itself: the import simply gets slower and then the container is killed. So the importer samples its
own resident set as it goes, and the benchmark asserts the samples are flat rather than trusting
the word "streaming".

Growth is measured by comparing the last quarter of the import against the first, which is robust
to the startup allocations every process makes and to the sawtooth of garbage collection.
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
import resource
from dataclasses import dataclass, field
from typing import Optional

PAGE_SIZE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096


def rss_bytes() -> int:
    """
    Current resident set size.

    Reads /proc/self/statm, which is the live value. `resource.getrusage` reports only the peak,
    which cannot show whether memory grew steadily or spiked once and was released.
    """
    try:
        with open("/proc/self/statm", "r", encoding="ascii") as fh:
            fields = fh.read().split()
        return int(fields[1]) * PAGE_SIZE
    except (OSError, IndexError, ValueError):
        # Not Linux, or /proc unavailable. Peak is worse than current, but better than nothing.
        return peak_rss_bytes()


def peak_rss_bytes() -> int:
    """Peak resident set size for this process."""
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Linux reports kilobytes; macOS reports bytes.
    return usage * 1024 if usage < (1 << 40) else usage


@dataclass
class MemorySample:
    processed: int
    rss: int


@dataclass
class MemoryProfile:
    """Samples taken during one import, plus the summary the benchmark asserts against."""

    samples: list[MemorySample] = field(default_factory=list)
    # Bounded: a 10M-entity import at one sample per 10k-row batch is 1,000 samples, but a smaller
    # batch size must not turn the profiler itself into the leak it is looking for.
    max_samples: int = 2_000

    def record(self, processed: int) -> None:
        if len(self.samples) >= self.max_samples:
            # Keep every other sample, halving the resolution rather than dropping the tail —
            # the end of the import is exactly where growth shows.
            self.samples = self.samples[::2]
            self.max_samples = max(self.max_samples, len(self.samples) * 2)
        self.samples.append(MemorySample(processed=processed, rss=rss_bytes()))

    @property
    def peak(self) -> int:
        return max((s.rss for s in self.samples), default=peak_rss_bytes())

    @property
    def first(self) -> Optional[int]:
        return self.samples[0].rss if self.samples else None

    @property
    def last(self) -> Optional[int]:
        return self.samples[-1].rss if self.samples else None

    def _quarter_means(self) -> Optional[tuple[float, float]]:
        if len(self.samples) < 8:
            return None
        quarter = max(1, len(self.samples) // 4)
        head = self.samples[:quarter]
        tail = self.samples[-quarter:]
        return (
            sum(s.rss for s in head) / len(head),
            sum(s.rss for s in tail) / len(tail),
        )

    def growth_ratio(self) -> Optional[float]:
        """
        Mean RSS of the last quarter divided by the mean of the first quarter.

        1.0 means flat. A streaming importer should sit near it; a value that tracks the entity
        count is the signature of something buffering.
        """
        means = self._quarter_means()
        return None if means is None else means[1] / means[0]

    def growth_bytes(self) -> Optional[int]:
        """
        Absolute growth between the same two quarters.

        Reported alongside the ratio because neither alone is a good test. A ratio of 1.4 on a
        30 MB process is module loading; the same ratio on a 2 GB one is half a gigabyte of
        accumulation. The budget applies both, and this type only reports.
        """
        means = self._quarter_means()
        return None if means is None else int(means[1] - means[0])

    def summary(self) -> dict:
        ratio = self.growth_ratio()
        growth = self.growth_bytes()
        return {
            "samples": len(self.samples),
            "peak_mb": round(self.peak / 1024 / 1024, 1),
            "first_mb": round(self.first / 1024 / 1024, 1) if self.first else None,
            "last_mb": round(self.last / 1024 / 1024, 1) if self.last else None,
            "growth_ratio": round(ratio, 3) if ratio is not None else None,
            "growth_mb": round(growth / 1024 / 1024, 1) if growth is not None else None,
        }


def format_bytes(value: int) -> str:
    mb = value / 1024 / 1024
    return f"{mb / 1024:.2f} GiB" if mb >= 1024 else f"{mb:.0f} MiB"
