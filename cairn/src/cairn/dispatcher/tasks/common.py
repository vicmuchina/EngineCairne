from __future__ import annotations

import logging
import os
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from cairn.dispatcher.config import DispatchConfig, WorkerConfig
from cairn.dispatcher.protocol.client import CairnClient
from cairn.dispatcher.runtime.cancellation import TaskCancellation
from cairn.dispatcher.runtime.containers import ContainerManager
from cairn.dispatcher.runtime.heartbeat import HeartbeatLease
from cairn.dispatcher.runtime.process import ProcessResult
from cairn.dispatcher.runtime.supervisor import ProcessSupervisor
from cairn.dispatcher.workers.activity import WorkerActivityRecorder

PROCESS_COMMUNICATE_GRACE_SECONDS = 15
LOG_PREVIEW_LIMIT = 1200
GRAPH_SNAPSHOT_ROOT = "/tmp/cairn-prompts"
WORKER_ACTIVITY_ENV = "CAIRN_WORKER_ACTIVITY"
LOG = logging.getLogger(__name__)


@dataclass(slots=True)
class ConcludeWriteResult:
    status: str
    fact_id: str | None = None


def preview(text: str, limit: int = LOG_PREVIEW_LIMIT) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[:limit] + "..."


def did_timeout(result: ProcessResult) -> bool:
    return not result.cancelled and (result.timed_out or result.returncode in (124, 137))


def cancel_reason(result: ProcessResult, cancellation: TaskCancellation | None = None) -> str | None:
    if result.cancelled:
        return result.cancel_reason or "cancelled"
    if cancellation is not None:
        return cancellation.reason
    return None


def communicate_timeout(timeout_seconds: int, grace_seconds: int = PROCESS_COMMUNICATE_GRACE_SECONDS) -> int:
    return timeout_seconds + grace_seconds


def task_healthcheck_enabled(config: DispatchConfig) -> bool:
    if config.runtime.execution == "local":
        return False
    return config.runtime.worker_healthcheck == "startup_and_task"


def fetch_pending_steering(
    client: CairnClient, project_id: str, *, intent_id: str | None = None
) -> list[dict]:
    """Pending operator steering for the next worker prompt (task-boundary delivery).

    Project-level steering (no intent_id) targets whichever task runs next; intent-level
    steering is only handed to that intent's explore task.
    """
    fetch = getattr(client, "pending_steering", None)
    if fetch is None:
        return []
    try:
        if intent_id is None:
            items = fetch(project_id, None, project_only=True)
        else:
            items = fetch(project_id, intent_id)
    except TypeError:
        # Older/simpler clients without the keyword.
        items = fetch(project_id, intent_id)
    except Exception:  # pragma: no cover - never fail a task because steering is unavailable
        LOG.warning("pending steering fetch failed project=%s", project_id, exc_info=True)
        return []
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


# A shell that cannot exec the worker reports these codes: the prompt never reached a
# worker, so steering carried by that prompt must stay pending for the next task.
SPAWN_FAILURE_CODES = (126, 127)


def worker_accepted_prompt(result: ProcessResult) -> bool:
    """Did the worker process actually start and receive its prompt?

    Steering is at-least-once: it is marked ``delivered`` only when the process really ran
    with it. A missing binary (126/127 from the ``sh -lc`` wrapper), a failed spawn (no
    output at all) or an immediate transport error means the prompt was never accepted, so
    the steering row stays ``pending`` and is re-delivered at the next task boundary.
    """
    if result.returncode in SPAWN_FAILURE_CODES:
        return False
    if not (result.stdout or "").strip() and not (result.stderr or "").strip():
        return False
    return True


def mark_steering_delivered(
    client: CairnClient,
    project_id: str,
    items: list[dict],
    worker: str,
    *,
    run: str | None = None,
    accepted: bool = True,
) -> None:
    """Mark steering delivered after a worker process ran with it in its prompt."""
    deliver = getattr(client, "deliver_steering", None)
    if deliver is None or not items:
        return
    if not accepted:
        LOG.warning(
            "steering delivery skipped because the worker never accepted the prompt "
            "project=%s worker=%s steering=%s",
            project_id,
            worker,
            [item.get("id") for item in items],
        )
        return
    for item in items:
        steering_id = item.get("id")
        if steering_id is None:
            continue
        try:
            response = deliver(project_id, int(steering_id), worker, run)
            if getattr(response, "ok", False):
                LOG.info(
                    "steering delivered project=%s steering=%s worker=%s",
                    project_id,
                    steering_id,
                    worker,
                )
            else:
                LOG.warning(
                    "steering delivery write failed project=%s steering=%s status=%s",
                    project_id,
                    steering_id,
                    getattr(response, "status_code", None),
                )
        except Exception:  # pragma: no cover
            LOG.warning(
                "steering delivery failed project=%s steering=%s", project_id, steering_id, exc_info=True
            )


def write_graph_snapshot_reference(
    container_manager: ContainerManager,
    container_name: str,
    graph_yaml: str,
    *,
    phase: str,
) -> str:
    path = f"{GRAPH_SNAPSHOT_ROOT}/{phase}-{uuid.uuid4().hex[:12]}/graph.yaml"
    container_manager.write_text_file(container_name, path, graph_yaml)
    return (
        "The graph YAML snapshot is stored in this file inside the current container:\n\n"
        f"{path}\n\n"
        "Before using the graph, read the entire file and treat its contents as the YAML snapshot "
        "for this Graph section."
    )


def _supervisor_timeout(activity: object | None, phase: str) -> None:
    """Mark the worker run timeout from the independent supervisor thread.

    The task thread may still be stuck in ``communicate()``; the recorder must not wait for
    it to expose the run as finished with ``timeout``. ``finish()`` is idempotent.
    """
    if activity is None:
        return
    finish = getattr(activity, "finish", None)
    if not callable(finish):
        return
    try:
        finish("timeout", error=f"worker process exceeded hard deadline during {phase}")
    except Exception:  # pragma: no cover - observability must never break the supervisor
        LOG.warning("failed to close timed-out worker activity phase=%s", phase, exc_info=True)


def run_worker_process(
    container_manager: ContainerManager,
    container_name: str,
    worker: WorkerConfig,
    argv: list[str],
    *,
    phase: str,
    timeout_seconds: int,
    lease: HeartbeatLease | None = None,
    cancellation: TaskCancellation | None = None,
    on_stdout_line: Callable[[str], None] | None = None,
    activity: object | None = None,
) -> ProcessResult:
    LOG.info(
        "starting container exec container=%s worker=%s phase=%s timeout=%ss",
        container_name,
        worker.name,
        phase,
        timeout_seconds,
    )
    kwargs = {"on_stdout_line": on_stdout_line} if on_stdout_line is not None else {}
    process = container_manager.build_exec_process(
        container_name,
        dict(worker.env),
        argv,
        timeout_seconds=timeout_seconds,
        **kwargs,
    )
    process.start()
    if lease is not None:
        lease.attach_process(process)
    if cancellation is not None:
        cancellation.attach_process(process)
    supervisor = ProcessSupervisor(
        process,
        timeout_seconds,
        grace_seconds=PROCESS_COMMUNICATE_GRACE_SECONDS,
        label=f"{worker.name}:{phase}",
        on_timeout=lambda: _supervisor_timeout(activity, phase),
    )
    supervisor.start()
    try:
        return process.communicate(timeout=communicate_timeout(timeout_seconds))
    finally:
        supervisor.stop()
        if lease is not None:
            lease.attach_process(None)
        if cancellation is not None:
            cancellation.attach_process(None)


def worker_activity_enabled() -> bool:
    """Worker activity capture is on by default; ``CAIRN_WORKER_ACTIVITY=0`` opts out."""
    value = os.environ.get(WORKER_ACTIVITY_ENV, "1").strip().lower()
    return value not in ("0", "false", "no", "off", "disabled")


def driver_streams_json_events(driver: object) -> bool:
    """True when the driver's stdout is pi JSONL worth parsing live."""
    check = getattr(driver, "streams_json_events", None)
    if not callable(check):
        return False
    try:
        return bool(check())
    except Exception:  # pragma: no cover - defensive
        return False


def start_worker_activity(
    client: CairnClient | object,
    project_id: str,
    worker_name: str,
    *,
    task: str,
    intent_id: str | None = None,
    intent_description: str | None = None,
) -> WorkerActivityRecorder | None:
    """Start a worker_run row + writer thread, or return None when unavailable.

    Observability must never prevent a worker from running: a client without the activity
    writer (e.g. an in-process test double) and any recorder construction error both yield
    None and the task continues exactly as before.
    """
    if not worker_activity_enabled():
        return None
    if getattr(client, "record_activity", None) is None:
        return None
    try:
        recorder = WorkerActivityRecorder(
            client,
            project_id=project_id,
            worker=worker_name,
            task=task,
            intent_id=intent_id,
            intent_description=intent_description,
        )
        recorder.start()
        return recorder
    except Exception:  # pragma: no cover - defensive, never break a task
        LOG.warning(
            "failed to start worker activity project=%s worker=%s task=%s",
            project_id,
            worker_name,
            task,
            exc_info=True,
        )
        return None


def finish_worker_activity(
    recorder: WorkerActivityRecorder | None,
    result: ProcessResult | None,
    *,
    session: str | None = None,
    error: str | None = None,
) -> None:
    """Close the run after the process returns (or raises); never raises."""
    if recorder is None:
        return
    try:
        recorder.finish(result=result, session=session, error=error)
    except Exception:  # pragma: no cover - observability must never break a task
        LOG.warning(
            "failed to finish worker activity project=%s run=%s",
            recorder.project_id,
            recorder.run_id,
            exc_info=True,
        )


def project_allows_conclude_fallback(client: CairnClient, project_id: str, *, worker_name: str, intent_id: str) -> bool:
    project = client.get_project(project_id)
    if project.project.status == "active":
        return True
    LOG.info(
        "skip conclude fallback because project is no longer active project=%s intent=%s worker=%s status=%s",
        project_id,
        intent_id,
        worker_name,
        project.project.status,
    )
    return False


def best_effort_release_reason(client: CairnClient, project_id: str, worker_name: str) -> None:
    response = client.release_reason(project_id, worker_name)
    if not response.ok and response.status_code not in (403, 409):
        LOG.warning(
            "reason release failed project=%s worker=%s status=%s",
            project_id,
            worker_name,
            response.status_code,
        )
    elif response.ok:
        LOG.info("released reason project=%s worker=%s", project_id, worker_name)
    else:
        LOG.info(
            "reason release skipped project=%s worker=%s status=%s",
            project_id,
            worker_name,
            response.status_code,
        )


def write_conclude_result(
    client: CairnClient,
    project_id: str,
    intent_id: str,
    worker_name: str,
    description: str,
    *,
    source: str,
    phase_ms: int,
    total_ms: int | None = None,
) -> str:
    return write_conclude_result_with_fact_id(
        client,
        project_id,
        intent_id,
        worker_name,
        description,
        source=source,
        phase_ms=phase_ms,
        total_ms=total_ms,
    ).status


def write_conclude_result_with_fact_id(
    client: CairnClient,
    project_id: str,
    intent_id: str,
    worker_name: str,
    description: str,
    *,
    source: str,
    phase_ms: int,
    total_ms: int | None = None,
) -> ConcludeWriteResult:
    response = client.conclude(project_id, intent_id, worker_name, description)
    if response.ok:
        fact_id: str | None = None
        if isinstance(response.data, dict):
            fact = response.data.get("fact")
            if isinstance(fact, dict):
                candidate = fact.get("id")
                if isinstance(candidate, str) and candidate:
                    fact_id = candidate
        if total_ms is None:
            LOG.info(
                "intent concluded project=%s intent=%s worker=%s source=%s phase_ms=%s",
                project_id,
                intent_id,
                worker_name,
                source,
                phase_ms,
            )
        else:
            LOG.info(
                "intent concluded project=%s intent=%s worker=%s source=%s phase_ms=%s total_ms=%s",
                project_id,
                intent_id,
                worker_name,
                source,
                phase_ms,
                total_ms,
            )
        return ConcludeWriteResult(status="success", fact_id=fact_id)
    if response.status_code == 403:
        LOG.info(
            "project became inactive during conclude project=%s intent=%s worker=%s",
            project_id,
            intent_id,
            worker_name,
        )
    else:
        LOG.warning(
            "conclude write failed project=%s intent=%s worker=%s status=%s body=%s",
            project_id,
            intent_id,
            worker_name,
            response.status_code,
            response.text,
        )
    best_effort_release(client, project_id, intent_id, worker_name)
    return ConcludeWriteResult(status="failed", fact_id=None)


def best_effort_release(client: CairnClient, project_id: str, intent_id: str, worker_name: str) -> None:
    response = client.release(project_id, intent_id, worker_name)
    if not response.ok and response.status_code not in (403, 409):
        LOG.warning(
            "release failed project=%s intent=%s worker=%s status=%s",
            project_id,
            intent_id,
            worker_name,
            response.status_code,
        )
    elif response.ok:
        LOG.info("released intent project=%s intent=%s worker=%s", project_id, intent_id, worker_name)
    else:
        LOG.info(
            "release skipped project=%s intent=%s worker=%s status=%s",
            project_id,
            intent_id,
            worker_name,
            response.status_code,
        )
