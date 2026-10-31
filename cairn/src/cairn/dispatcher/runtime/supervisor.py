from __future__ import annotations

"""Independent hard-deadline supervisor for one worker process.

``ProcessSupervisor`` runs in its own daemon thread, not in the scheduler loop and not in
the task thread that waits for the process. If the task-side ``communicate()`` path is
stuck (blocked pipe drain, hung docker call, child ignoring SIGTERM, ...), the supervisor
still fires at ``timeout + grace``, marks the process timed out, kills its process group and
gives the activity recorder a terminal ``timeout`` row. This is the backstop that keeps a
single bad worker from holding a worker slot forever.
"""

import logging
import threading
import time
from collections.abc import Callable

from cairn.dispatcher.runtime.process import ExecProcess

LOG = logging.getLogger(__name__)


class ProcessSupervisor:
    def __init__(
        self,
        process: ExecProcess,
        timeout_seconds: float,
        *,
        grace_seconds: float = 15.0,
        label: str = "worker",
        on_timeout: Callable[[], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._process = process
        self._timeout_seconds = max(0.0, float(timeout_seconds))
        self._grace_seconds = max(0.0, float(grace_seconds))
        self._label = label
        self._on_timeout = on_timeout
        self._clock = clock
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._fired = False
        self._fired_lock = threading.Lock()

    @property
    def deadline_seconds(self) -> float:
        return self._timeout_seconds + self._grace_seconds

    @property
    def fired(self) -> bool:
        return self._fired

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            name=f"cairn-process-supervisor-{self._label}"[:64],
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        started = self._clock()
        deadline = started + self.deadline_seconds
        while not self._stop.is_set():
            remaining = deadline - self._clock()
            if remaining <= 0:
                self._fire()
                return
            # Wake periodically so a normal completion is noticed promptly even when the
            # deadline is minutes away.
            self._stop.wait(min(5.0, remaining))

    def _fire(self) -> None:
        with self._fired_lock:
            if self._fired:
                return
            self._fired = True
        LOG.error(
            "worker hard deadline exceeded label=%s timeout=%.1fs grace=%.1fs; "
            "marking timeout and killing process group",
            self._label,
            self._timeout_seconds,
            self._grace_seconds,
        )
        mark = getattr(self._process, "mark_timed_out", None)
        if callable(mark):
            try:
                mark()
            except Exception:  # pragma: no cover - defensive
                LOG.warning("failed to mark process timed out label=%s", self._label, exc_info=True)
        try:
            self._process.kill()
        except Exception:  # pragma: no cover - kill must not kill the supervisor
            LOG.warning("failed to kill timed-out process label=%s", self._label, exc_info=True)
        if self._on_timeout is not None:
            try:
                self._on_timeout()
            except Exception:  # pragma: no cover - observability only
                LOG.warning("timeout callback failed label=%s", self._label, exc_info=True)

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=2.0)
        self._thread = None
