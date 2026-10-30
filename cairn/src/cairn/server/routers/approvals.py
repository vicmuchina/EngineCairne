from __future__ import annotations

"""Approval queue.

An approval is a **record of a human decision**, not a capability. The honest boundary is:

* ``rest_boundary = advisory`` — the REST API is *not* gated. Anyone able to reach the
  Cairn HTTP port can write to the graph directly; approvals cannot stop them.
* ``enforcement = execution-layer`` — approvals are enforced where actions are actually
  executed: the MainAgent control client (:mod:`cairn.control.client`) and the pi
  ``cairn-approval`` extension. Both are fail-closed: no ``approved`` decision means the
  action does not run. When the gate set is empty the policy reports
  ``enforcement="none"`` instead of claiming enforcement that is not wired.
* ``single_use`` — an approved request can be consumed exactly once
  (``POST /approvals/{id}/consume``, which **requires** the matching ``action_hash``), and
  it is bound to ``action_hash`` so an approval for one action can never authorise a
  different one. A row without ``action_hash`` is not consumable at all (fail-closed).

This is deliberate: we do not pretend the REST API requires a decision. ``GET
/approvals/policy`` returns the same statement in machine-readable form, computed from the
*current* gate configuration (`CAIRN_APPROVAL_ACTIONS`, `CAIRN_CHAT_APPROVAL_TOOLS`).

Localhost only: Cairn assumes the HTTP API is bound to 127.0.0.1 with no authentication
(see RUNTIME-V3.md). The approval queue is not an authentication mechanism.
"""

import asyncio
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query

from cairn.control.client import DEFAULT_GATED_ACTIONS, approval_actions
from cairn.server import activity as activity_store
from cairn.server.db import get_conn
from cairn.server.models import (
    ApprovalConsumeRequest,
    ApprovalCreateRequest,
    ApprovalDecisionRequest,
    ApprovalItem,
    ApprovalList,
    ApprovalPolicy,
)
from cairn.server.services import get_project_or_404, utcnow

router = APIRouter(tags=["approvals"])
POLL_SECONDS = 0.25


def _gated_chat_tools() -> list[str]:
    raw = os.environ.get("CAIRN_CHAT_APPROVAL_TOOLS", "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def build_policy() -> ApprovalPolicy:
    """Describe the *configured* gate honestly, not an aspirational one."""
    actions = sorted(approval_actions())
    tools = _gated_chat_tools()
    enforced_by: list[str] = []
    if actions:
        enforced_by.append("cairn.control.client.run_action (MainAgent actions)")
    if tools:
        enforced_by.append("chat_extensions/cairn-approval.js (pi tool calls in chat)")
    notes = [
        "The approval queue does not gate REST writes; it records decisions and the "
        "execution layers refuse to act without an approved, unconsumed, hash-matching row.",
        "Expired requests are marked expired on every read path (queue, overview, chat "
        "context), not only when they are first fetched.",
        "Consume requires the action_hash of the approved action; an approval without a "
        "stored hash cannot be consumed (fail-closed) and no execution layer will run it.",
    ]
    if not actions:
        notes.append(
            "The MainAgent action gate is currently empty (CAIRN_APPROVAL_ACTIONS is set to "
            "a disabled value), so add_hint/add_intent/set_project_status/steer_intent run "
            "without an approval. Unset CAIRN_APPROVAL_ACTIONS restores the default gate "
            f"({', '.join(sorted(DEFAULT_GATED_ACTIONS))})."
        )
    else:
        notes.append(
            "Default gate: when CAIRN_APPROVAL_ACTIONS is unset the gate covers "
            f"{', '.join(sorted(DEFAULT_GATED_ACTIONS))}; it is never silently empty."
        )
    notes.append(
        "Worker/container tool approvals are NOT implemented: dispatcher workers run pi "
        "with --no-extensions. Wiring them needs (a) the cairn-approval extension mounted "
        "into the worker image, (b) --extension <path> added in PiDriver._wrap_with_models, "
        "(c) CAIRN_APPROVAL_URL/CAIRN_APPROVAL_PROJECT/CAIRN_APPROVAL_TOOLS in the worker "
        "env, and (d) the same action_hash + consume contract for the tool_call action."
    )
    return ApprovalPolicy(
        rest_boundary="advisory",
        enforcement="execution-layer" if enforced_by else "none",
        enforced_by=enforced_by,
        gate_active=bool(enforced_by),
        gated_actions=actions,
        gated_chat_tools=tools,
        single_use=True,
        action_binding="sha256(action+payload), re-verified and consumed before execution",
        tool_approvals=(
            "chat pi sessions only (fail-closed, consume-before-execute); dispatcher "
            "workers are not gated"
        ),
        worker_approvals="not implemented: dispatcher workers run with --no-extensions",
        transport_trust="localhost, unauthenticated",
        notes=notes,
    )


def _row_or_404(conn: sqlite3.Connection, approval_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM approval_requests WHERE id = ?", (approval_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Approval not found")
    return row


def _to_model(row: sqlite3.Row) -> ApprovalItem:
    payload = {}
    if row["payload"]:
        try:
            payload = json.loads(row["payload"])
        except json.JSONDecodeError:
            payload = {"raw": row["payload"]}
    metadata = {}
    if row["metadata"]:
        try:
            metadata = json.loads(row["metadata"])
        except json.JSONDecodeError:
            metadata = {"raw": row["metadata"]}
    keys = row.keys()
    return ApprovalItem(
        id=row["id"],
        project_id=row["project_id"],
        conversation_id=row["conversation_id"],
        action=row["action"],
        payload=payload,
        status=row["status"],
        requested_by=row["requested_by"],
        requested_at=row["requested_at"],
        decided_by=row["decided_by"],
        decided_at=row["decided_at"],
        decision_note=row["decision_note"],
        expires_at=row["expires_at"],
        metadata=metadata,
        action_hash=row["action_hash"] if "action_hash" in keys else None,
        consumed_at=row["consumed_at"] if "consumed_at" in keys else None,
        consumed_by=row["consumed_by"] if "consumed_by" in keys else None,
    )


def _expire(conn: sqlite3.Connection, project_id: str | None = None) -> None:
    activity_store.expire_pending_approvals(conn, project_id)


@router.get("/approvals/policy", response_model=ApprovalPolicy)
def approval_policy():
    """State exactly what the approval queue enforces (and what it does not)."""
    return build_policy()


@router.post(
    "/projects/{project_id}/approvals", response_model=ApprovalItem, status_code=201
)
def create_approval(project_id: str, body: ApprovalCreateRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        now = utcnow()
        expires_at = None
        if body.expires_in:
            expires_at = (
                datetime.now(timezone.utc) + timedelta(seconds=body.expires_in)
            ).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        cursor = conn.execute(
            """
            INSERT INTO approval_requests
                (project_id, conversation_id, action, payload, status, requested_by,
                 requested_at, expires_at, metadata, action_hash)
            VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                body.conversation_id,
                body.action,
                json.dumps(body.payload, ensure_ascii=False),
                body.requested_by,
                now,
                expires_at,
                json.dumps({"note": body.note}, ensure_ascii=False) if body.note else None,
                body.action_hash,
            ),
        )
        activity_store.record_activity(
            conn,
            project_id,
            kind="approval",
            title=f"Approval requested: {body.action}",
            description=body.note or json.dumps(body.payload, ensure_ascii=False)[:500],
            actor=body.requested_by,
            status="pending",
            metadata={"approval_id": cursor.lastrowid, "action": body.action},
            created_at=now,
        )
        return _to_model(_row_or_404(conn, cursor.lastrowid))


@router.get("/projects/{project_id}/approvals", response_model=ApprovalList)
def list_approvals(
    project_id: str,
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        # Bulk expiry before the query, so a filter of status=pending can never return a
        # row whose deadline already passed.
        _expire(conn, project_id)
        query = "SELECT * FROM approval_requests WHERE project_id = ?"
        params: list = [project_id]
        if status:
            query += " AND status = ?"
            params.append(status)
        query += " ORDER BY requested_at, id LIMIT ?"
        params.append(limit)
        rows = conn.execute(query, params).fetchall()
        pending = conn.execute(
            "SELECT COUNT(*) FROM approval_requests WHERE project_id = ? AND status = 'pending'",
            (project_id,),
        ).fetchone()[0]
        return ApprovalList(items=[_to_model(row) for row in rows], pending=pending)


@router.get("/approvals", response_model=ApprovalList)
def list_all_approvals(
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
):
    """Cross-project queue for the Approvals tab."""
    with get_conn() as conn:
        _expire(conn)
        query = "SELECT * FROM approval_requests"
        params: list = []
        if status:
            query += " WHERE status = ?"
            params.append(status)
        query += " ORDER BY requested_at DESC, id DESC LIMIT ?"
        params.append(limit)
        rows = conn.execute(query, params).fetchall()
        pending = conn.execute(
            "SELECT COUNT(*) FROM approval_requests WHERE status = 'pending'"
        ).fetchone()[0]
        return ApprovalList(items=[_to_model(row) for row in rows], pending=pending)


@router.get("/approvals/{approval_id}", response_model=ApprovalItem)
async def get_approval(approval_id: int, wait: float = Query(default=0, ge=0, le=120)):
    """Fetch one approval; ``wait`` long-polls (async) while it is still pending."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait
    while True:
        with get_conn() as conn:
            _expire(conn)
            row = _row_or_404(conn, approval_id)
            model = _to_model(row)
            pending = row["status"] == "pending"
        if not pending or loop.time() >= deadline:
            return model
        await asyncio.sleep(POLL_SECONDS)


def _decide(approval_id: int, body: ApprovalDecisionRequest, status: str) -> ApprovalItem:
    """Atomic decision.

    The winning writer is decided by a single ``UPDATE ... WHERE status='pending'
    RETURNING *``; a loser re-reads the row and gets a 409. The activity row is written
    only by the winner, so a concurrent approve+deny pair produces exactly one activity.
    """
    with get_conn() as conn:
        _expire(conn)
        row = _row_or_404(conn, approval_id)
        if row["status"] != "pending":
            raise HTTPException(409, f"Approval is already {row['status']}")
        now = utcnow()
        updated = conn.execute(
            """
            UPDATE approval_requests
            SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
            WHERE id = ? AND status = 'pending'
            RETURNING *
            """,
            (status, body.decided_by, now, body.note, approval_id),
        ).fetchone()
        if updated is None:
            current = _row_or_404(conn, approval_id)
            raise HTTPException(
                409, f"Approval is already {current['status']} (concurrent decision)"
            )
        if updated["project_id"]:
            activity_store.record_activity(
                conn,
                updated["project_id"],
                kind="approval",
                title=f"Approval {status}: {updated['action']}",
                description=body.note,
                actor=body.decided_by,
                status=status,
                metadata={"approval_id": approval_id, "action": updated["action"]},
                created_at=now,
            )
        return _to_model(updated)


@router.post("/approvals/{approval_id}/approve", response_model=ApprovalItem)
def approve(approval_id: int, body: ApprovalDecisionRequest):
    return _decide(approval_id, body, "approved")


@router.post("/approvals/{approval_id}/deny", response_model=ApprovalItem)
def deny(approval_id: int, body: ApprovalDecisionRequest):
    return _decide(approval_id, body, "denied")


@router.post("/approvals/{approval_id}/consume", response_model=ApprovalItem)
def consume(approval_id: int, body: ApprovalConsumeRequest):
    """Burn an approved request exactly once (called by the execution layer).

    The caller must present the ``action_hash`` of the action it is about to run; the
    server compares it with the stored hash and refuses on any mismatch. A row without a
    stored hash is not consumable (fail-closed) — v3 allowed hashless consume, which meant
    an approval could not be bound to what it authorised.

    Returns 400 when the request carries no hash, 409 when the request is not approved,
    was already consumed, has no stored hash, or the hashes differ.
    """
    with get_conn() as conn:
        _expire(conn)
        row = _row_or_404(conn, approval_id)
        if row["status"] != "approved":
            raise HTTPException(409, f"Approval is {row['status']}, not approved")
        keys = row.keys()
        stored_hash = row["action_hash"] if "action_hash" in keys else None
        if not stored_hash:
            raise HTTPException(
                409,
                "Approval has no action_hash: it is not bound to an action and cannot be "
                "consumed (fail-closed)",
            )
        if not body.action_hash:
            raise HTTPException(400, "action_hash is required to consume an approval")
        if body.action_hash != stored_hash:
            raise HTTPException(409, "action_hash does not match this approval")
        if "consumed_at" in keys and row["consumed_at"]:
            raise HTTPException(409, "Approval was already consumed")
        now = utcnow()
        updated = conn.execute(
            """
            UPDATE approval_requests
            SET consumed_at = ?, consumed_by = ?
            WHERE id = ? AND status = 'approved' AND consumed_at IS NULL
            RETURNING *
            """,
            (now, body.consumed_by, approval_id),
        ).fetchone()
        if updated is None:
            raise HTTPException(409, "Approval was already consumed (concurrent consume)")
        if updated["project_id"]:
            activity_store.record_activity(
                conn,
                updated["project_id"],
                kind="approval",
                title=f"Approval consumed: {updated['action']}",
                description=f"consumed_by={body.consumed_by}",
                actor=body.consumed_by,
                status="consumed",
                metadata={"approval_id": approval_id, "action": updated["action"]},
                created_at=now,
            )
        return _to_model(updated)
