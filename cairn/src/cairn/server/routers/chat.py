from __future__ import annotations

"""Chat API: persistent main-agent conversations backed by ``pi``.

Two execution paths are supported by :mod:`cairn.server.chat_runtime`:

* ``rpc`` (default) — one persistent ``pi --mode rpc`` process per conversation. This is
  what makes ``POST /chat/conversations/{id}/steer`` real: the steer is written to the live
  process and pi delivers it after the current tool calls, before the next model call.
* ``json`` (``CAIRN_CHAT_RPC=0``) — the v2 one-shot turn. The steer endpoint returns 409 in
  this mode instead of pretending to deliver.
"""

import asyncio
import sqlite3
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator

from cairn.server import activity as activity_store
from cairn.server import chat_runtime
from cairn.server.db import get_conn
from cairn.server.services import get_project_or_404, utcnow

router = APIRouter(prefix="/chat", tags=["chat"])

STALE_RUN_ERROR = "The server restarted or lost the pi process before this turn finished"
CANCELLED_RUN_ERROR = "Request cancelled before the turn finished (client disconnected)"


# ------------------------------------------------------------------------- models


class ChatConversation(BaseModel):
    id: int
    project_id: str
    title: str
    status: Literal["idle", "running", "error"]
    created_at: str
    updated_at: str
    message_count: int
    last_message: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    activity_count: int = 0


class ChatMessage(BaseModel):
    id: int
    seq: int
    role: Literal["user", "assistant", "system", "tool"]
    content: str
    status: Literal["done", "running", "error", "stopped"]
    error: str | None = None
    created_at: str
    run_id: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None


class ChatActivity(BaseModel):
    id: int
    conversation_id: int
    message_id: int | None = None
    run_id: str | None = None
    seq: int
    kind: str
    role: str | None = None
    content: str | None = None
    tool_name: str | None = None
    tool_call_id: str | None = None
    tool_input: str | None = None
    tool_output: str | None = None
    status: str
    error: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    created_at: str
    raw: str | None = None


class ChatActivityList(BaseModel):
    items: list[ChatActivity]
    next_after_seq: int
    has_more: bool
    conversation_id: int


class CreateConversationRequest(BaseModel):
    project_id: str
    title: str | None = Field(default=None, max_length=200)

    @field_validator("project_id")
    @classmethod
    def validate_project_id(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class SendMessageRequest(BaseModel):
    message: str = Field(min_length=1)

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be empty")
        return value


class SteerRequest(BaseModel):
    message: str = Field(min_length=1)

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be empty")
        return value


class SteerResponse(BaseModel):
    accepted: bool
    conversation_id: int
    run_id: str | None = None
    disposition: str | None = None
    activity_id: int | None = None
    detail: str | None = None


class ConversationList(BaseModel):
    items: list[ChatConversation]


class MessageList(BaseModel):
    items: list[ChatMessage]


class SendMessageResponse(BaseModel):
    items: list[ChatMessage]
    conversation: ChatConversation


class StopResponse(BaseModel):
    stopped: bool
    reconciled: bool = False
    conversation: ChatConversation
    mode: str | None = None
    # ``stopped`` is only true once the turn's outcome was persisted. ``detail`` says what
    # actually happened for the other cases (signalled but still winding down, no live
    # turn, stale reconcile), so the UI never has to guess.
    detail: str | None = None


# ------------------------------------------------------------------------ helpers


def _conversation_or_404(conn: sqlite3.Connection, conversation_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM chat_conversations WHERE id = ?", (conversation_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Conversation not found")
    return row


def _message_from_row(row: sqlite3.Row) -> ChatMessage:
    keys = row.keys()
    return ChatMessage(
        id=row["id"],
        seq=row["seq"],
        role=row["role"],
        content=row["content"],
        status=row["status"],
        error=row["error"],
        created_at=row["created_at"],
        run_id=row["run_id"] if "run_id" in keys else None,
        tokens_in=row["tokens_in"] if "tokens_in" in keys else None,
        tokens_out=row["tokens_out"] if "tokens_out" in keys else None,
    )


def _activity_from_row(row: sqlite3.Row, *, include_raw: bool = False) -> ChatActivity:
    return ChatActivity(
        id=row["id"],
        conversation_id=row["conversation_id"],
        message_id=row["message_id"],
        run_id=row["run_id"],
        seq=row["seq"],
        kind=row["kind"],
        role=row["role"],
        content=row["content"],
        tool_name=row["tool_name"],
        tool_call_id=row["tool_call_id"],
        tool_input=row["tool_input"],
        tool_output=row["tool_output"],
        status=row["status"],
        error=row["error"],
        tokens_in=row["tokens_in"],
        tokens_out=row["tokens_out"],
        created_at=row["created_at"],
        raw=row["raw_json"] if include_raw else None,
    )


def _conversation_from_row(conn: sqlite3.Connection, row: sqlite3.Row) -> ChatConversation:
    stats = conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?) AS message_count,
            (SELECT content FROM chat_messages WHERE conversation_id = ?
             ORDER BY seq DESC LIMIT 1) AS last_message,
            (SELECT COALESCE(SUM(tokens_in), 0) FROM chat_messages
             WHERE conversation_id = ? AND role = 'assistant') AS tokens_in,
            (SELECT COALESCE(SUM(tokens_out), 0) FROM chat_messages
             WHERE conversation_id = ? AND role = 'assistant') AS tokens_out,
            (SELECT COUNT(*) FROM chat_activities WHERE conversation_id = ?) AS activity_count
        """,
        (row["id"],) * 5,
    ).fetchone()
    return ChatConversation(
        id=row["id"],
        project_id=row["project_id"],
        title=row["title"],
        status=row["status"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        message_count=stats["message_count"],
        last_message=stats["last_message"],
        tokens_in=stats["tokens_in"],
        tokens_out=stats["tokens_out"],
        activity_count=stats["activity_count"],
    )


def _reconcile_stale_run(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    *,
    stale_status: str = "error",
    conversation_status: str = "error",
    error_text: str = STALE_RUN_ERROR,
) -> sqlite3.Row:
    """Recover a conversation stuck in ``running`` with no live pi process.

    This happens if the server was restarted or the request task died mid-turn. We never
    pretend the turn succeeded: in-flight messages become ``error``/``stopped``.
    """
    if row["status"] != "running" or chat_runtime.has_live_process(row["id"]):
        return row
    now = utcnow()
    conn.execute(
        """
        UPDATE chat_messages
        SET status = ?, error = COALESCE(error, ?)
        WHERE conversation_id = ? AND status = 'running'
        """,
        (stale_status, error_text, row["id"]),
    )
    activity_store.close_open_activities(
        conn, row["id"], status=stale_status, error=error_text
    )
    conn.execute(
        """
        UPDATE chat_runs
        SET status = ?, ended_at = ?, stderr_tail = COALESCE(stderr_tail, '')
        WHERE conversation_id = ? AND status = 'running'
        """,
        (stale_status, now, row["id"]),
    )
    conn.execute(
        "UPDATE chat_conversations SET status = ?, updated_at = ? WHERE id = ?",
        (conversation_status, now, row["id"]),
    )
    return conn.execute(
        "SELECT * FROM chat_conversations WHERE id = ?", (row["id"],)
    ).fetchone()


def _finalize_turn(
    *,
    conversation_id: int,
    run_id: str,
    run: chat_runtime.ChatRun,
    user_message_id: int,
    assistant_message_id: int,
    recorder: activity_store.ChatActivityRecorder,
    result: chat_runtime.TurnResult,
) -> SendMessageResponse:
    """Persist the outcome of one turn. Plain sync: it must not be interrupted.

    Called from the normal path and from the ``CancelledError`` path (where the request
    task is being torn down), so it deliberately has no ``await`` points.
    """
    summary = recorder.finish(result.status, result.error)
    if recorder.events == 0 and result.status == "error":
        # pi produced no JSON events at all (spawn failure, crash before output, ...).
        # Record the failure the server observed; never invent stream content. A stopped
        # turn is not a failure and needs no synthetic error row.
        recorder.note_run_failure(result.error or result.status)
    content = result.content
    if result.status == "stopped" and not content:
        # Aborted mid-stream: pi never emitted message_end, so use the partial text this
        # run actually streamed (never another run's text).
        content = recorder.last_run_assistant_text()
    with get_conn() as conn:
        now = utcnow()
        conn.execute(
            """
            UPDATE chat_messages
            SET content = ?, status = ?, error = ?, tokens_in = ?, tokens_out = ?
            WHERE id = ? AND conversation_id = ?
            """,
            (
                content,
                result.status,
                result.error,
                summary["tokens_in"] or None,
                summary["tokens_out"] or None,
                assistant_message_id,
                conversation_id,
            ),
        )
        conn.execute(
            """
            UPDATE chat_runs
            SET pid = ?, pid_start_ticks = COALESCE(?, pid_start_ticks), status = ?,
                ended_at = ?, exit_code = ?, stderr_tail = ?,
                tokens_in = ?, tokens_out = ?, turns = ?, tool_calls = ?, model = ?
            WHERE id = ?
            """,
            (
                run.pid if run.pid is not None else (run.proc.pid if run.proc is not None else None),
                run.pid_start_ticks,
                result.status,
                now,
                result.exit_code,
                result.stderr_tail,
                summary["tokens_in"],
                summary["tokens_out"],
                summary["turns"],
                summary["tool_calls"],
                summary["model"],
                run_id,
            ),
        )
        conversation_status = "idle" if result.status in ("done", "stopped") else "error"
        conn.execute(
            "UPDATE chat_conversations SET status = ?, updated_at = ? WHERE id = ?",
            (conversation_status, now, conversation_id),
        )
        messages = conn.execute(
            "SELECT * FROM chat_messages WHERE id IN (?, ?) ORDER BY seq",
            (user_message_id, assistant_message_id),
        ).fetchall()
        updated = conn.execute(
            "SELECT * FROM chat_conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        return SendMessageResponse(
            items=[_message_from_row(message) for message in messages],
            conversation=_conversation_from_row(conn, updated),
        )


# ------------------------------------------------------------------------- routes


@router.get("/conversations", response_model=ConversationList)
def list_conversations(project_id: str | None = Query(default=None)):
    with get_conn() as conn:
        if project_id is not None:
            get_project_or_404(conn, project_id)
            rows = conn.execute(
                "SELECT * FROM chat_conversations WHERE project_id = ? "
                "ORDER BY updated_at DESC, id DESC",
                (project_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM chat_conversations ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        items = [
            _conversation_from_row(conn, _reconcile_stale_run(conn, row)) for row in rows
        ]
        return ConversationList(items=items)


@router.post("/conversations", response_model=ChatConversation, status_code=201)
def create_conversation(body: CreateConversationRequest):
    with get_conn() as conn:
        get_project_or_404(conn, body.project_id)
        title = (body.title or "").strip() or "New conversation"
        now = utcnow()
        cursor = conn.execute(
            """
            INSERT INTO chat_conversations
                (project_id, title, pi_session_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'idle', ?, ?)
            """,
            (body.project_id, title, f"cairn-chat-{uuid.uuid4()}", now, now),
        )
        row = conn.execute(
            "SELECT * FROM chat_conversations WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        return _conversation_from_row(conn, row)


@router.get("/conversations/{conversation_id}", response_model=ChatConversation)
def get_conversation(conversation_id: int):
    with get_conn() as conn:
        row = _reconcile_stale_run(conn, _conversation_or_404(conn, conversation_id))
        return _conversation_from_row(conn, row)


@router.get("/conversations/{conversation_id}/messages", response_model=MessageList)
def list_messages(conversation_id: int):
    with get_conn() as conn:
        _reconcile_stale_run(conn, _conversation_or_404(conn, conversation_id))
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq",
            (conversation_id,),
        ).fetchall()
        return MessageList(items=[_message_from_row(row) for row in rows])


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=SendMessageResponse,
)
async def send_message(conversation_id: int, body: SendMessageRequest):
    """Store the user message, run exactly one pi turn, then store the assistant reply."""
    run_id = uuid.uuid4().hex
    with get_conn() as conn:
        row = _reconcile_stale_run(conn, _conversation_or_404(conn, conversation_id))
        if row["status"] == "running":
            raise HTTPException(409, "Conversation already has a running turn")
        get_project_or_404(conn, row["project_id"])

        try:
            run = chat_runtime.try_begin(conversation_id, run_id)
        except chat_runtime.ConversationBusy:
            raise HTTPException(409, "Conversation already has a running turn") from None

        try:
            now = utcnow()
            next_seq = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()[0]
            user_cursor = conn.execute(
                """
                INSERT INTO chat_messages
                    (conversation_id, seq, role, content, status, error, run_id, created_at)
                VALUES (?, ?, 'user', ?, 'done', NULL, ?, ?)
                """,
                (conversation_id, next_seq, body.message, run_id, now),
            )
            assistant_cursor = conn.execute(
                """
                INSERT INTO chat_messages
                    (conversation_id, seq, role, content, status, error, run_id, created_at)
                VALUES (?, ?, 'assistant', '', 'running', NULL, ?, ?)
                """,
                (conversation_id, next_seq + 1, run_id, now),
            )
            conn.execute(
                """
                INSERT INTO chat_runs
                    (id, conversation_id, message_id, pid, status, started_at, mode)
                VALUES (?, ?, ?, NULL, 'running', ?, ?)
                """,
                (run_id, conversation_id, assistant_cursor.lastrowid, now, chat_runtime.runtime_mode()),
            )
            conn.execute(
                "UPDATE chat_conversations SET status = 'running', updated_at = ? WHERE id = ?",
                (now, conversation_id),
            )
            system_context = chat_runtime.build_system_context(conn, row)
            user_message_id = user_cursor.lastrowid
            assistant_message_id = assistant_cursor.lastrowid
        except Exception:
            chat_runtime.finish(run)
            raise

    recorder = activity_store.ChatActivityRecorder(
        conversation_id,
        run_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
    )
    run.recorder = recorder
    executor = (
        chat_runtime.execute_rpc_turn
        if chat_runtime.rpc_enabled()
        else chat_runtime.execute_turn
    )
    try:
        try:
            result = await executor(
                conversation=row,
                system_context=system_context,
                user_message=body.message,
                run=run,
                timeout=chat_runtime.timeout_seconds(),
                recorder=recorder,
            )
        except asyncio.CancelledError:
            # Client disconnect / server shutdown: the turn is over. Record it as stopped so
            # the conversation does not stay "running" until a later stale reconcile, then
            # let the cancellation propagate.
            _finalize_turn(
                conversation_id=conversation_id,
                run_id=run_id,
                run=run,
                user_message_id=user_message_id,
                assistant_message_id=assistant_message_id,
                recorder=recorder,
                result=chat_runtime.TurnResult(
                    "stopped",
                    recorder.last_run_assistant_text(),
                    CANCELLED_RUN_ERROR,
                    None,
                    "",
                    False,
                    True,
                ),
            )
            raise
        except Exception as exc:
            recorder.finish("error", f"chat runtime crashed: {exc}")
            with get_conn() as conn:
                now = utcnow()
                conn.execute(
                    "UPDATE chat_messages SET status = 'error', error = ? "
                    "WHERE id = ? AND conversation_id = ?",
                    (f"chat runtime crashed: {exc}", assistant_message_id, conversation_id),
                )
                conn.execute(
                    "UPDATE chat_runs SET status = 'error', ended_at = ? WHERE id = ?",
                    (now, run_id),
                )
                conn.execute(
                    "UPDATE chat_conversations SET status = 'error', updated_at = ? WHERE id = ?",
                    (now, conversation_id),
                )
            raise
        return _finalize_turn(
            conversation_id=conversation_id,
            run_id=run_id,
            run=run,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            recorder=recorder,
            result=result,
        )
    finally:
        # Release the running slot only after the rows above are committed, so a
        # concurrent stop/delete request never observes a half-finalized turn.
        chat_runtime.finish(run)


@router.post(
    "/conversations/{conversation_id}/steer",
    response_model=SteerResponse,
)
async def steer_conversation(conversation_id: int, body: SteerRequest):
    """Deliver a live mid-turn steering message to the conversation's pi process.

    The activity is written **only after** pi acknowledged the steer with a successful
    ``{"type":"response","command":"steer","success":true}``. An idle conversation is
    refused (pi would happily queue the message for the *next* prompt, which is not what
    the caller asked for).
    """
    from cairn.server import pi_rpc

    with get_conn() as conn:
        row = _conversation_or_404(conn, conversation_id)
        if row["status"] != "running":
            raise HTTPException(409, "Conversation has no running turn to steer")
    if not chat_runtime.rpc_enabled():
        raise HTTPException(
            409,
            "Live steering needs pi RPC mode (CAIRN_CHAT_RPC=1); "
            "the one-shot json mode can only steer at task boundaries",
        )

    gate = chat_runtime.get_run(conversation_id)
    if gate is None:
        raise HTTPException(409, "Conversation has no running turn to steer")

    outcome = await pi_rpc.manager().steer(conversation_id, body.message)
    if not outcome.get("accepted"):
        raise HTTPException(409, outcome.get("detail") or "Steering was not accepted")

    activity_id: int | None = None
    recorder = gate.recorder
    if recorder is not None:
        try:
            activity_id = recorder.note_steering(
                body.message, status=str(outcome.get("disposition") or "queued")
            )
        except Exception:  # pragma: no cover - never fail a delivered steer on logging
            activity_id = None
    return SteerResponse(
        accepted=True,
        conversation_id=conversation_id,
        run_id=gate.run_id,
        disposition=outcome.get("disposition"),
        activity_id=activity_id,
        detail=outcome.get("detail"),
    )


@router.get(
    "/conversations/{conversation_id}/activities",
    response_model=ChatActivityList,
)
def list_activities(
    conversation_id: int,
    after_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    run_id: str | None = Query(default=None),
    kind: str | None = Query(default=None, description="Comma-separated activity kinds"),
    include_raw: bool = Query(default=False),
):
    """Step-level trace of the conversation, ordered by monotonic ``seq`` (pollable)."""
    with get_conn() as conn:
        _reconcile_stale_run(conn, _conversation_or_404(conn, conversation_id))
        query = (
            "SELECT * FROM chat_activities WHERE conversation_id = ? AND seq > ?"
        )
        params: list = [conversation_id, after_seq]
        if run_id:
            query += " AND run_id = ?"
            params.append(run_id)
        if kind:
            kinds = [item.strip() for item in kind.split(",") if item.strip()]
            if kinds:
                query += f" AND kind IN ({', '.join('?' for _ in kinds)})"
                params.extend(kinds)
        query += " ORDER BY seq LIMIT ?"
        params.append(limit + 1)
        rows = conn.execute(query, params).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        items = [_activity_from_row(row, include_raw=include_raw) for row in rows]
        next_seq = items[-1].seq if items else after_seq
        return ChatActivityList(
            items=items,
            next_after_seq=next_seq,
            has_more=has_more,
            conversation_id=conversation_id,
        )


@router.post("/conversations/{conversation_id}/stop", response_model=StopResponse)
async def stop_conversation(conversation_id: int):
    with get_conn() as conn:
        row = _conversation_or_404(conn, conversation_id)
        if row["status"] != "running":
            return StopResponse(
                stopped=False,
                conversation=_conversation_from_row(conn, row),
                mode=chat_runtime.runtime_mode(),
                detail="Conversation has no running turn to stop",
            )
        if not chat_runtime.has_live_process(conversation_id):
            # Stale: the process is gone but the rows still say running.
            row = _reconcile_stale_run(
                conn,
                row,
                stale_status="stopped",
                conversation_status="idle",
                error_text="No live pi process to stop (server may have restarted)",
            )
            return StopResponse(
                stopped=False,
                reconciled=True,
                conversation=_conversation_from_row(conn, row),
                mode=chat_runtime.runtime_mode(),
                detail="No live pi process: the stale running rows were reconciled as stopped",
            )

    outcome = await chat_runtime.stop_run(conversation_id)

    with get_conn() as conn:
        row = _reconcile_stale_run(conn, _conversation_or_404(conn, conversation_id))
        return StopResponse(
            stopped=outcome.stopped,
            conversation=_conversation_from_row(conn, row),
            mode=chat_runtime.runtime_mode(),
            detail=outcome.detail,
        )


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: int):
    from cairn.server import pi_rpc

    with get_conn() as conn:
        row = _conversation_or_404(conn, conversation_id)
        was_running = row["status"] == "running"
    if was_running:
        await chat_runtime.stop_run(conversation_id)
    await pi_rpc.manager().close_session(conversation_id)
    with get_conn() as conn:
        _conversation_or_404(conn, conversation_id)
        conn.execute("DELETE FROM chat_conversations WHERE id = ?", (conversation_id,))
    return Response(status_code=204)
