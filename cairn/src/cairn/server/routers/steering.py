from __future__ import annotations

"""Operator/MainAgent steering queue.

Worker steering is consumed at *task boundaries*: the dispatcher reads pending rows when it
builds a reason/explore prompt and marks them delivered only once the worker process
actually accepted that prompt.

Live mid-turn steering for the **chat** MainAgent is separate and immediate: it goes over
the conversation's persistent ``pi --mode rpc`` stdin (``POST /chat/conversations/{id}/steer``,
see :mod:`cairn.server.pi_rpc`), not through this table. Dispatcher workers still run
one-shot ``pi --mode json -p`` processes, so they cannot be steered mid-turn yet (see the
phase-2 design in RUNTIME-V3.md).
"""

import sqlite3

from fastapi import APIRouter, HTTPException, Query

from cairn.server import activity as activity_store
from cairn.server.db import get_conn
from cairn.server.models import (
    SteeringCreateRequest,
    SteeringDeliverRequest,
    SteeringItem,
    SteeringList,
)
from cairn.server.services import get_intent_or_404, get_project_or_404, utcnow

router = APIRouter(tags=["steering"])


def _steering_or_404(conn: sqlite3.Connection, project_id: str, steering_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM steering WHERE id = ? AND project_id = ?", (steering_id, project_id)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Steering not found")
    return row


def _to_model(row: sqlite3.Row) -> SteeringItem:
    return SteeringItem(
        id=row["id"],
        project_id=row["project_id"],
        intent_id=row["intent_id"],
        message=row["message"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        status=row["status"],
        delivered_at=row["delivered_at"],
        delivered_to=row["delivered_to"],
        delivered_run=row["delivered_run"],
    )


@router.post(
    "/projects/{project_id}/steering", response_model=SteeringItem, status_code=201
)
def create_steering(project_id: str, body: SteeringCreateRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        if body.intent_id is not None:
            get_intent_or_404(conn, project_id, body.intent_id)
        now = utcnow()
        cursor = conn.execute(
            """
            INSERT INTO steering (project_id, intent_id, message, created_by, created_at, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
            """,
            (project_id, body.intent_id, body.message, body.created_by, now),
        )
        activity_store.record_activity(
            conn,
            project_id,
            kind="steering",
            title=f"Steering queued for {body.intent_id or 'project'}",
            description=body.message,
            actor=body.created_by,
            status="pending",
            metadata={"steering_id": cursor.lastrowid, "intent_id": body.intent_id},
            created_at=now,
        )
        row = _steering_or_404(conn, project_id, cursor.lastrowid)
        return _to_model(row)


@router.get("/projects/{project_id}/steering", response_model=SteeringList)
def list_steering(
    project_id: str,
    pending: bool = Query(default=False),
    intent_id: str | None = Query(default=None),
    project_only: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        query = "SELECT * FROM steering WHERE project_id = ?"
        params: list = [project_id]
        if pending:
            query += " AND status = 'pending'"
        if project_only:
            query += " AND intent_id IS NULL"
        if intent_id is not None:
            query += " AND (intent_id IS NULL OR intent_id = ?)"
            params.append(intent_id)
        query += " ORDER BY created_at, id LIMIT ?"
        params.append(limit)
        rows = conn.execute(query, params).fetchall()
        pending_count = conn.execute(
            "SELECT COUNT(*) FROM steering WHERE project_id = ? AND status = 'pending'",
            (project_id,),
        ).fetchone()[0]
        return SteeringList(items=[_to_model(row) for row in rows], pending=pending_count)


@router.post(
    "/projects/{project_id}/steering/{steering_id}/delivered",
    response_model=SteeringItem,
)
def mark_delivered(project_id: str, steering_id: int, body: SteeringDeliverRequest):
    """Dispatcher callback: the steering text was included in a worker prompt."""
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        row = _steering_or_404(conn, project_id, steering_id)
        if row["status"] == "delivered":
            return _to_model(row)
        now = utcnow()
        conn.execute(
            """
            UPDATE steering
            SET status = 'delivered', delivered_at = ?, delivered_to = ?, delivered_run = ?
            WHERE id = ? AND project_id = ? AND status = 'pending'
            """,
            (now, body.worker, body.run, steering_id, project_id),
        )
        activity_store.record_activity(
            conn,
            project_id,
            kind="steering",
            title=f"Steering delivered to {body.worker}",
            description=row["message"],
            actor=body.worker,
            status="delivered",
            metadata={
                "steering_id": steering_id,
                "intent_id": row["intent_id"],
                "run": body.run,
            },
            source="dispatcher",
            created_at=now,
        )
        return _to_model(_steering_or_404(conn, project_id, steering_id))


@router.delete("/projects/{project_id}/steering/{steering_id}", status_code=204)
def cancel_steering(project_id: str, steering_id: int):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        _steering_or_404(conn, project_id, steering_id)
        conn.execute(
            "UPDATE steering SET status = 'cancelled' WHERE id = ? AND project_id = ? "
            "AND status = 'pending'",
            (steering_id, project_id),
        )
    return None
