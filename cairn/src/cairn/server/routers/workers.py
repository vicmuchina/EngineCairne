from __future__ import annotations

"""Worker observability API (R3.2b).

The dispatcher records one ``worker_run`` row per worker process plus the transcript pi
emitted (``worker_thinking``, ``tool_call``, ``tool_result``, ``worker_message``,
``worker_error``, ``worker_output``) as ``project_activity`` rows sharing a ``run_id``.
These endpoints expose that data without changing the fact graph or the chat runtime.

Contract for the UI:

* ``GET /projects/{id}/workers`` — active/recent runs, newest first, each with
  ``worker``/``task``/``intent_id``/``intent_description``, status, timestamps and (by
  default) the last ``transcript_limit`` steps in emission order.
* ``GET /projects/{id}/workers/runs/{run_id}`` — one run (same shape).
* Polling ``GET /projects/{id}/workers`` every second is sufficient for a live view; the
  transcript is a snapshot, ordered by ``project_activity.id`` (never re-sorted by the
  client). ``active`` is false for a stale run (no finish row AND no event for
  ``stale_after_seconds``), so a crashed dispatcher cannot look alive forever.
* ``PATCH /projects/{id}/workers/activity/{activity_id}`` — dispatcher-only live updates
  (streaming text/status). Only rows with a ``run_id`` and a worker transcript kind can be
  touched.
* ``POST /projects/{id}/workers/runs/{run_id}/close`` — idempotent terminal row; closes
  every open child row so a cancelled/timed-out run has no ``running`` leftovers.
"""

from fastapi import APIRouter, HTTPException, Query

from cairn.server import activity as activity_store
from cairn.server.db import get_conn
from cairn.server.models import (
    ProjectActivityItem,
    WorkerActivityUpdate,
    WorkerRunCloseRequest,
    WorkerRunItem,
    WorkerRunList,
)
from cairn.server.services import get_project_or_404

router = APIRouter(tags=["workers"])


@router.get("/projects/{project_id}/workers", response_model=WorkerRunList)
def list_project_workers(
    project_id: str,
    worker: str | None = Query(default=None, description="Filter by worker name"),
    exclude_task: str | None = Query(default=None, description="Exclude runs by task (e.g. reason)"),
    run_id: str | None = Query(default=None, description="Filter by exact run id"),
    active_only: bool = Query(default=False, description="Only runs still active (not stale)"),
    include_transcript: bool = Query(default=True, description="Include the transcript steps"),
    limit: int = Query(default=20, ge=1, le=100, description="Runs to return, newest first"),
    transcript_limit: int = Query(
        default=200, ge=0, le=2000, description="Newest transcript steps per run (0 = none)"
    ),
    stale_after_seconds: int = Query(
        default=900, ge=0, description="A running run with no event for this long is stale"
    ),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        payload = activity_store.build_project_workers(
            conn,
            project_id,
            worker=worker,
            run_id=run_id,
            exclude_task=exclude_task,
            active_only=active_only,
            include_transcript=include_transcript,
            limit=limit,
            transcript_limit=transcript_limit,
            stale_after_seconds=stale_after_seconds,
        )
        return WorkerRunList(**payload)


@router.get("/projects/{project_id}/workers/runs/{run_id}", response_model=WorkerRunItem)
def get_worker_run(
    project_id: str,
    run_id: str,
    include_transcript: bool = Query(default=True),
    transcript_limit: int = Query(default=200, ge=0, le=2000),
    stale_after_seconds: int = Query(default=900, ge=0),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        payload = activity_store.build_worker_run(
            conn,
            project_id,
            run_id,
            transcript_limit=transcript_limit,
            include_transcript=include_transcript,
            stale_after_seconds=stale_after_seconds,
        )
        if payload is None:
            raise HTTPException(404, f"Worker run not found: {run_id}")
        return WorkerRunItem(**payload)


@router.post("/projects/{project_id}/workers/runs/{run_id}/close", response_model=WorkerRunItem)
def close_worker_run(
    project_id: str,
    run_id: str,
    body: WorkerRunCloseRequest | None = None,
):
    body = body or WorkerRunCloseRequest()
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        activity_store.close_worker_run(
            conn,
            project_id,
            run_id,
            status=body.status,
            error=body.error,
            metadata=body.metadata,
        )
        payload = activity_store.build_worker_run(
            conn, project_id, run_id, transcript_limit=0, include_transcript=False
        )
        assert payload is not None
        return WorkerRunItem(**payload)


@router.patch(
    "/projects/{project_id}/workers/activity/{activity_id}",
    response_model=ProjectActivityItem,
)
def update_worker_activity(
    project_id: str,
    activity_id: int,
    body: WorkerActivityUpdate,
):
    if (
        body.status is None
        and body.description is None
        and body.error is None
        and body.metadata is None
    ):
        raise HTTPException(400, "At least one of status/description/error/metadata is required")
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        try:
            row = activity_store.update_worker_activity(
                conn,
                project_id,
                activity_id,
                status=body.status,
                description=body.description,
                error=body.error,
                metadata=body.metadata,
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        if row is None:
            raise HTTPException(404, f"Activity not found: {activity_id}")
        return ProjectActivityItem(**activity_store.project_activity_item(row, project_id))
