from __future__ import annotations

"""Scheduler progress watchdog.

The dispatcher is a single scheduling loop: if one blocking call never returns, every
project stops making progress while the process still looks alive to systemd. The watchdog
is an independent thread that trips when the loop has not touched it for
``timeout_seconds`` and exits the process with the conventional temporary-failure code 75
so a ``Restart=always`` unit starts a clean dispatcher.

``check()`` is deliberately side-effect free apart from calling ``exit_fn`` and is driven
by an injectable clock, so the exit path can be unit-tested without sleeping or killing the
test process.
"""

import logging
import os
import threading
import time
from collections.abc import Callable

LOG = logging.getLogger(__name__)

WATCHDOG_EXIT_CODE = 75


class LoopWatchdog:
    def __init__(
        self,
        timeout_seconds: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        exit_fn: Callable[[int], None] = os._exit,
        check_interval_seconds: float | None = None,
        name: str = "cairn-scheduler-watchdog",
    ):
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self._clock = clock
        self._exit_fn = exit_fn
        self._interval = max(
            0.05,
            float(check_interval_seconds)
            if check_interval_seconds is not None
            else min(5.0, self.timeout_seconds / 4.0),
        )
        self._name = name
        self._last_progress = clock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tripped = False

    @property
    def last_progress(self) -> float:
        return self._last_progress

    @property
    def tripped(self) -> bool:
        return self._tripped

    def touch(self, now: float | None = None) -> None:
        """Mark scheduler progress. Call it on every loop iteration and inside long work."""
        self._last_progress = self._clock() if now is None else now

    def check(self, now: float | None = None) -> bool:
        """Trip the watchdog if the clock moved past the deadline. Returns True if tripped."""
        if self._tripped:
            return True
        current = self._clock() if now is None else now
        elapsed = current - self._last_progress
        if elapsed <= self.timeout_seconds:
            return False
        self._tripped = True
        LOG.critical(
            "scheduler watchdog expired no_progress_for=%.1fs timeout=%.1fs; exiting(%s) "
            "for a clean systemd restart",
            elapsed,
            self.timeout_seconds,
            WATCHDOG_EXIT_CODE,
        )
        self._exit_fn(WATCHDOG_EXIT_CODE)
        return True

    def start(self) -> None:
        if self._thread is not None:
            return
        LOG.info(
            "scheduler watchdog armed timeout=%.1fs check_interval=%.2fs exit_code=%s",
            self.timeout_seconds,
            self._interval,
            WATCHDOG_EXIT_CODE,
        )
        self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            if self.check():
                return

    def sleep(self, seconds: float) -> None:
        """Sleep between scheduler iterations without looking wedged.

        Long configured intervals are legitimate no-progress periods: touch the watchdog
        in small chunks so only a *blocked* loop trips it.
        """
        remaining = max(0.0, float(seconds))
        while remaining > 0 and not self._stop.is_set():
            chunk = min(1.0, remaining)
            self._stop.wait(chunk)
            remaining -= chunk
            self.touch()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=2.0)
        self._thread = None
