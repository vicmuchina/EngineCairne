from __future__ import annotations

"""Dispatcher-side worker activity recorder.

The dispatcher and the API server are separate processes, and the dispatcher talks to the
server over HTTP (``CairnClient``). This recorder is the bridge: pi's stdout lines are
parsed (:mod:`cairn.dispatcher.workers.pi_events`) and persisted as ``project_activity``
rows through the existing activity writer.

Design constraints:

* the callback runs on the stdout drain thread, so HTTP writes must never block it — a
  bounded queue and one writer thread decouple the two; dropping is counted and reported,
  never silently pretended to be delivered;
* the final ``worker_run`` row and the closing of still-open child rows are posted after
  every queued event, so a cancelled/timed-out run has no ``running`` rows left behind;
* only events pi emitted are persisted. Non-JSON stdout is preserved verbatim as
  ``worker_output``; nothing is reconstructed.
"""

import logging
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from cairn.dispatcher.runtime.process import ProcessResult
from cairn.dispatcher.workers.pi_events import PiWorkerEventParser, WorkerEmission

LOG = logging.getLogger(__name__)

MAX_QUEUE = 2_000
FINISH_JOIN_TIMEOUT_SECONDS = 12.0
MAX_ERROR = 4_000
CLOSE_ATTEMPTS = 2


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _usage_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _usage_cost(value: Any) -> float:
    if isinstance(value, dict):
        value = value.get("total") or value.get("cost") or 0
    if isinstance(value, bool):
        return 0.0
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def empty_usage() -> dict[str, Any]:
    return {
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
        "reasoning": 0,
        "total_tokens": 0,
        "cost": 0.0,
    }


def add_usage(total: dict[str, Any], usage: Any) -> None:
    if not isinstance(usage, dict):
        return
    total["input"] = int(total.get("input", 0)) + _usage_int(usage.get("input"))
    total["output"] = int(total.get("output", 0)) + _usage_int(usage.get("output"))
    total["cache_read"] = int(total.get("cache_read", 0)) + _usage_int(usage.get("cacheRead"))
    total["cache_write"] = int(total.get("cache_write", 0)) + _usage_int(usage.get("cacheWrite"))
    total["reasoning"] = int(total.get("reasoning", 0)) + _usage_int(usage.get("reasoning"))
    total["total_tokens"] = int(total.get("total_tokens", 0)) + _usage_int(
        usage.get("totalTokens")
    )
    total["cost"] = float(total.get("cost", 0.0)) + _usage_cost(usage.get("cost"))


def _clip(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    if len(value) <= limit:
        return value
    return value[:limit] + f"…[truncated {len(value) - limit} chars]"


def worker_run_status(result: ProcessResult | None, error: str | None = None) -> str:
    """Map a finished process to the worker_run terminal status."""
    if result is None:
        return "failed" if error else "success"
    if result.cancelled:
        return "cancelled"
    if result.timed_out or result.returncode in (124, 137):
        return "timeout"
    if result.returncode == 0:
        return "success"
    return "failed"


def format_duration(duration_ms: int | None) -> str:
    """Human duration for the interruption card (``3m50s``, ``42s``, ``1h02m``)."""
    if duration_ms is None:
        return "unknown"
    seconds = max(0, int(duration_ms) // 1000)
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def interruption_reason(status: str, result: ProcessResult | None = None) -> str:
    """Artex-style interruption reason derived from the terminal status."""
    if result is not None and result.cancel_reason == "stopped":
        return "paused_by_user"
    if status == "timeout" or (result is not None and result.timed_out):
        return "timeout"
    return "cancelled"


def interruption_description(
    *,
    reason: str,
    status: str,
    turns: int,
    duration_ms: int | None,
    usage: dict[str, Any],
    tool: dict[str, Any] | None,
) -> str:
    """Plain-text (markdown-ish) interruption report body — the row's description."""
    lines = [
        f"The run was interrupted: {reason}. Terminal state: {status}.",
        f"Executed: {turns} model turns. This run took: {format_duration(duration_ms)}.",
        "Cumulative tokens: "
        f"input {int(usage.get('input', 0))} / output {int(usage.get('output', 0))} "
        f"/ cache read {int(usage.get('cache_read', 0))}.",
    ]
    if tool is None:
        lines.append("Tool running at interruption: none (no tool call was in flight).")
    else:
        name = tool.get("name") or "unknown"
        tool_input = tool.get("input") or ""
        lines.append(
            f"Tool running at interruption: {name} {tool_input} (returned no result)."
        )
    return "\n".join(lines)


def worker_run_error(result: ProcessResult | None, error: str | None = None) -> str | None:
    if error:
        return _clip(error, MAX_ERROR)
    if result is None:
        return "worker process did not run"
    if result.cancelled:
        # A deliberate stop is not an error; the cancel reason is in the run metadata.
        return None
    if result.timed_out:
        return "worker timed out"
    if result.returncode != 0:
        tail = result.stderr.strip() if result.stderr else ""
        if tail:
            return _clip(tail[-MAX_ERROR:], MAX_ERROR)
        return f"worker exited with code {result.returncode}"
    return None


@dataclass(slots=True)
class _Finish:
    status: str
    error: str | None
    metadata: dict[str, Any] = field(default_factory=dict)


class WorkerActivityRecorder:
    """Persist one worker process run and its pi transcript as ``project_activity``."""

    def __init__(
        self,
        client: Any,
        *,
        project_id: str,
        worker: str,
        task: str,
        intent_id: str | None = None,
        intent_description: str | None = None,
        run_id: str | None = None,
        parser: PiWorkerEventParser | None = None,
    ):
        self.client = client
        self.project_id = project_id
        self.worker = worker
        self.task = task
        self.intent_id = intent_id
        self.intent_description = _clip(intent_description, 2_000)
        self.run_id = run_id or uuid.uuid4().hex
        self.parser = parser or PiWorkerEventParser(worker)
        self.started_at = _utcnow()
        self._started_monotonic = time.monotonic()
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=MAX_QUEUE)
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._finish_lock = threading.Lock()
        self._slots: dict[str, int | None] = {}
        self._finished = False
        self._finish_posted = False
        self._dropped = 0
        self._logged_post_failure = False
        self._usage = empty_usage()
        self._model: str | None = None
        self._usage_lock = threading.Lock()

    # -- lifecycle --------------------------------------------------------
    def start(self) -> None:
        if self._thread is not None:
            return
        self._queue.put_nowait(("start", None))
        self._thread = threading.Thread(
            target=self._writer,
            name=f"cairn-worker-activity-{self.run_id[:8]}",
            daemon=True,
        )
        self._thread.start()

    def feed_line(self, line: str) -> None:
        """Callback for ``LocalProcess``/``ManagedProcess`` stdout framing."""
        if self._finished:
            return
        with self._lock:
            emissions = self.parser.feed_line(line)
        for emission in emissions:
            self._track_usage(emission)
            self._enqueue_emission(emission)

    def feed_event(self, event: dict[str, Any]) -> None:
        if self._finished:
            return
        with self._lock:
            emissions = self.parser.feed_event(event)
        for emission in emissions:
            self._track_usage(emission)
            self._enqueue_emission(emission)

    def finish(
        self,
        status: str | None = None,
        *,
        error: str | None = None,
        result: ProcessResult | None = None,
        session: str | None = None,
        duration_ms: int | None = None,
    ) -> None:
        """Flush, then append the terminal ``worker_run`` row (idempotent)."""
        with self._finish_lock:
            if self._finished:
                return
            self._finished = True
            if self._thread is None:
                # Defensive: a caller can finish a recorder that was never started; make
                # sure the queue is still drained (start row then finish row).
                try:
                    self._queue.put_nowait(("start", None))
                except queue.Full:  # pragma: no cover
                    pass
                self._thread = threading.Thread(
                    target=self._writer,
                    name=f"cairn-worker-activity-{self.run_id[:8]}",
                    daemon=True,
                )
                self._thread.start()
            with self._lock:
                emissions = self.parser.flush()
            for emission in emissions:
                self._track_usage(emission)
                self._enqueue_emission(emission)
            terminal = status or worker_run_status(result, error)
            ended_at = _utcnow()
            if duration_ms is None:
                duration_ms = max(0, int((time.monotonic() - self._started_monotonic) * 1000))
            with self._usage_lock:
                usage = dict(self._usage)
                model = self._model
            if terminal in ("cancelled", "timeout"):
                # One extra row *before* the terminal worker_run row so the transcript
                # explains why the run stopped (Artex interruption card).
                self._enqueue_interruption(
                    terminal,
                    result=result,
                    duration_ms=duration_ms,
                    usage=usage,
                )
            metadata: dict[str, Any] = {
                "run_id": self.run_id,
                "worker": self.worker,
                "task": self.task,
                "intent_id": self.intent_id,
                "intent_description": self.intent_description,
                "started_at": self.started_at,
                "finished_at": ended_at,
                "duration_ms": duration_ms,
                "session": session or self.parser.session,
                "dropped_events": self._dropped,
                "source": "dispatcher",
                "usage": usage,
            }
            if model:
                metadata["model"] = model
            if result is not None:
                metadata.update(
                    {
                        "returncode": result.returncode,
                        "timed_out": result.timed_out,
                        "cancelled": result.cancelled,
                        "cancel_reason": result.cancel_reason,
                        "stdout_chars": len(result.stdout or ""),
                        "stderr_chars": len(result.stderr or ""),
                    }
                )
            finish = _Finish(
                status=terminal,
                error=worker_run_error(result, error),
                metadata=metadata,
            )
            try:
                self._queue.put(("finish", finish), timeout=5)
            except queue.Full:  # pragma: no cover - writer stalled
                LOG.error(
                    "worker activity queue full at finish project=%s run=%s; leaving the run open",
                    self.project_id,
                    self.run_id,
                )
                return
        if self._thread is not None:
            self._thread.join(timeout=FINISH_JOIN_TIMEOUT_SECONDS)
            if self._thread.is_alive():  # pragma: no cover - server hung
                # Do NOT post the terminal row from here: the writer may still deliver
                # queued transcript rows afterwards, which would appear after the finish.
                # Leave the run open (the API reports it stale) rather than corrupt order.
                LOG.error(
                    "worker activity writer did not finish project=%s run=%s; leaving the run open",
                    self.project_id,
                    self.run_id,
                )
            elif not self._finish_posted:
                # The writer died before it could persist the terminal row.
                self._post_finish(finish)

    # -- usage ------------------------------------------------------------
    def _track_usage(self, emission: WorkerEmission) -> None:
        """Fold pi usage into the run total (writer-thread safe).

        ``worker_message`` carries usage for turns that produced prose; ``worker_usage``
        covers tool-call-only turns that emit no message row, so the run total is not
        limited to the one message that happened to contain text.
        """
        if emission.kind not in ("worker_message", "worker_usage"):
            return
        metadata = emission.metadata or {}
        model = metadata.get("model")
        usage = metadata.get("usage")
        with self._usage_lock:
            if isinstance(model, str) and model:
                self._model = model
            if isinstance(usage, dict):
                add_usage(self._usage, usage)

    @property
    def usage(self) -> dict[str, Any]:
        with self._usage_lock:
            return dict(self._usage)

    @property
    def model(self) -> str | None:
        with self._usage_lock:
            return self._model

    # -- queue ------------------------------------------------------------
    def _enqueue_emission(self, emission: WorkerEmission) -> None:
        # Usage-only emissions are accounting signals, not transcript rows.
        if emission.kind == "worker_usage":
            return
        try:
            self._queue.put_nowait(("emission", emission))
        except queue.Full:
            self._dropped += 1
            if self._dropped == 1:
                LOG.warning(
                    "worker activity queue full; dropping transcript events project=%s run=%s",
                    self.project_id,
                    self.run_id,
                )

    def _writer(self) -> None:
        try:
            while True:
                kind, payload = self._queue.get()
                try:
                    if kind == "start":
                        self._post_start()
                    elif kind == "emission":
                        self._post_emission(payload)
                    elif kind == "finish":
                        try:
                            self._post_finish(payload)
                        except Exception:  # pragma: no cover - close failure must not hang the task
                            LOG.warning(
                                "worker activity close write failed project=%s run=%s",
                                self.project_id,
                                self.run_id,
                                exc_info=True,
                            )
                        return
                except Exception:  # pragma: no cover - observability must never break dispatch
                    LOG.warning(
                        "worker activity write failed project=%s run=%s kind=%s",
                        self.project_id,
                        self.run_id,
                        kind,
                        exc_info=True,
                    )
                finally:
                    self._queue.task_done()
        finally:
            # Each recorder owns a short-lived writer thread; without this its pooled
            # requests.Session would stay in CairnClient._sessions for the dispatcher's life.
            close = getattr(self.client, "close_thread_session", None)
            if callable(close):
                try:
                    close()
                except Exception:  # pragma: no cover
                    LOG.debug("closing worker activity HTTP session failed", exc_info=True)

    def _enqueue_interruption(
        self,
        terminal: str,
        *,
        result: ProcessResult | None,
        duration_ms: int | None,
        usage: dict[str, Any],
    ) -> None:
        """Queue the structured interruption row for a cancelled/timed-out run."""
        try:
            snapshot = self.parser.interruption_snapshot()
        except Exception:  # pragma: no cover - observability must never break finish
            LOG.debug("interruption snapshot failed project=%s run=%s",
                      self.project_id, self.run_id, exc_info=True)
            snapshot = {"turns": 0, "tool": None, "thinking": ""}
        reason = interruption_reason(terminal, result)
        turns = int(snapshot.get("turns") or 0)
        tool = snapshot.get("tool")
        description = interruption_description(
            reason=reason,
            status=terminal,
            turns=turns,
            duration_ms=duration_ms,
            usage=usage,
            tool=tool,
        )
        emission = WorkerEmission(
            slot="interruption",
            kind="worker_interruption",
            status="done",
            title="Worker run interrupted",
            description=description,
            metadata={
                "reason": reason,
                "terminal_state": terminal,
                "turns": turns,
                "duration_ms": duration_ms,
                "usage": {
                    "input": int(usage.get("input", 0)),
                    "output": int(usage.get("output", 0)),
                    "cache_read": int(usage.get("cache_read", 0)),
                },
                "tool": tool,
                "thinking": snapshot.get("thinking") or None,
            },
            update=False,
        )
        # The normal queue is correct here: it is one row and it must stay ordered
        # before the finish row. If the queue is full the row is counted as dropped
        # rather than silently reordering the transcript.
        self._enqueue_emission(emission)

    # -- HTTP writes ------------------------------------------------------
    def _base_metadata(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        metadata: dict[str, Any] = {
            "run_id": self.run_id,
            "worker": self.worker,
            "task": self.task,
            "intent_id": self.intent_id,
            "intent_description": self.intent_description,
        }
        if extra:
            metadata.update(extra)
        return metadata

    def _record(self, *, kind: str, title: str, status: str, description: str | None,
                metadata: dict[str, Any]) -> int | None:
        record = getattr(self.client, "record_activity", None)
        if record is None:
            raise RuntimeError("client has no record_activity")
        try:
            response = record(
                self.project_id,
                kind=kind,
                title=title,
                description=description,
                actor=self.worker,
                status=status,
                metadata=metadata,
                run_id=self.run_id,
            )
        except TypeError:
            # Older client without the run_id keyword: still persist the row; grouping
            # falls back to metadata.
            response = record(
                self.project_id,
                kind=kind,
                title=title,
                description=description,
                actor=self.worker,
                status=status,
                metadata=metadata,
            )
        if not getattr(response, "ok", False):
            self._warn_post_failure("record", getattr(response, "status_code", None))
            return None
        data = getattr(response, "data", None)
        if isinstance(data, dict):
            item_id = data.get("id")
            if isinstance(item_id, str) and item_id.startswith("event:"):
                try:
                    return int(item_id.split(":", 1)[1])
                except ValueError:
                    return None
        return None

    def _post_start(self) -> None:
        self._record(
            kind="worker_run",
            title=f"{self.task} worker {self.worker} started",
            status="running",
            description=self.intent_description,
            metadata=self._base_metadata({"started_at": self.started_at, "source": "dispatcher"}),
        )

    def _post_emission(self, emission: WorkerEmission) -> None:
        slot_id = self._slots.get(emission.slot)
        if emission.update and slot_id is not None:
            update = getattr(self.client, "update_worker_activity", None)
            if update is None:
                return
            try:
                response = update(
                    self.project_id,
                    slot_id,
                    status=emission.status,
                    description=emission.description,
                    metadata=self._base_metadata(emission.metadata),
                )
            except TypeError:
                response = update(
                    self.project_id,
                    slot_id,
                    status=emission.status,
                    metadata=self._base_metadata(emission.metadata),
                )
            if not getattr(response, "ok", False):
                self._warn_post_failure("update", getattr(response, "status_code", None))
            return
        if emission.update and emission.slot in self._slots:
            # The create response carried no row id (non-standard client). Re-creating
            # would duplicate the row, so keep the original and drop the partial.
            return
        created = self._record(
            kind=emission.kind,
            title=emission.title,
            status=emission.status,
            description=emission.description,
            metadata=self._base_metadata(emission.metadata),
        )
        self._slots[emission.slot] = created

    def _post_finish(self, finish: _Finish) -> None:
        close = getattr(self.client, "close_worker_run", None)
        if close is not None:
            for attempt in range(CLOSE_ATTEMPTS):
                try:
                    response = close(
                        self.project_id,
                        self.run_id,
                        status=finish.status,
                        error=finish.error,
                        metadata=finish.metadata,
                    )
                except TypeError:
                    response = close(
                        self.project_id,
                        self.run_id,
                        status=finish.status,
                        metadata=finish.metadata,
                    )
                if getattr(response, "ok", False):
                    self._finish_posted = True
                    return
                self._warn_post_failure("close", getattr(response, "status_code", None))
                if attempt + 1 < CLOSE_ATTEMPTS:
                    time.sleep(0.25)
            LOG.error(
                "worker activity close failed after %s attempts project=%s run=%s status=%s",
                CLOSE_ATTEMPTS,
                self.project_id,
                self.run_id,
                finish.status,
            )
            return
        # Older server/client without the worker endpoints: append the terminal row with
        # the generic activity writer so the run is at least not left looking active.
        self._record(
            kind="worker_run",
            title=f"{self.task} worker {self.worker} finished ({finish.status})",
            status=finish.status,
            description=finish.error,
            metadata=finish.metadata,
        )
        self._finish_posted = True

    def _warn_post_failure(self, operation: str, status_code: int | None) -> None:
        if self._logged_post_failure:
            return
        self._logged_post_failure = True
        LOG.warning(
            "worker activity %s failed project=%s run=%s status=%s",
            operation,
            self.project_id,
            self.run_id,
            status_code,
        )


def activity_metadata(recorder: WorkerActivityRecorder | None) -> dict[str, Any]:
    """Small helper for call sites that want to log the run id."""
    if recorder is None:
        return {}
    return {"run_id": recorder.run_id, "worker": recorder.worker}
