from __future__ import annotations

"""Artex-shaped sessions API: main/plan/worker/system lanes + reverse-paginated activities."""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from cairn.server import sessions as session_store
from cairn.server.db import get_conn
from cairn.server.models import SessionActivityPage, SessionList
from cairn.server.services import get_project_or_404

router = APIRouter(tags=["sessions"])


@router.get("/projects/{project_id}/sessions", response_model=SessionList)
def list_project_sessions(project_id: str):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        return SessionList(**session_store.build_project_sessions(conn, project_id))


@router.get(
    "/projects/{project_id}/sessions/stream",
    response_class=StreamingResponse,
)
async def stream_project_sessions(
    project_id: str,
    since: int = Query(default=0, ge=0, description="Last project_activity id received"),
):
    # Validate the project before opening the stream so an unknown id is a normal 404.
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
    return StreamingResponse(
        session_store.stream_session_events(project_id, since),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get(
    "/projects/{project_id}/sessions/{key}/activities",
    response_model=SessionActivityPage,
)
def list_session_activities(
    project_id: str,
    key: str,
    before: int | None = Query(default=None, ge=1, description="Return the page ending before this seq"),
    limit: int = Query(default=200, ge=1, le=500),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        payload = session_store.build_session_activities(
            conn, project_id, key, before=before, limit=limit
        )
        if payload is None:
            raise HTTPException(404, f"Unknown session key: {key}")
        return SessionActivityPage(**payload)
