from __future__ import annotations

"""Activity persistence for the Cairn runtime.

Two related stores live here:

``chat_activities``
    The step-level trace of a ``pi --mode json`` turn (session header, turns, assistant
    text/thinking, tool calls and results, usage, errors, compaction). Only events pi
    actually emitted are persisted; the recorder never synthesizes stream content.

``project_activity``
    Events the fact graph itself cannot express: worker lifecycle, steering delivery,
    approvals, project status changes. Facts/intents/hints stay in their own tables and
    are merged into the project feed by :func:`build_project_activity`.

The recorder is intentionally DB-per-write: the HTTP server reads activities while a
turn is still running, so rows must be visible immediately (SQLite WAL allows that).
"""

import json
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any

from cairn.server.db import get_conn
from cairn.server.services import utcnow

MAX_CONTENT = 20_000
MAX_TOOL_OUTPUT = 20_000
MAX_RAW_JSON = 20_000
STREAM_FLUSH_SECONDS = 0.25

OPEN_STATUSES = ("running", "streaming", "pending", "queued")

# pi session events that are worth showing on the project broadcast board.
FEED_CHAT_KINDS = ("message", "tool_call", "error", "compaction", "steering")

# Feed kind -> chat_activities.kind values that produce it.
CHAT_FEED_KINDS: dict[str, tuple[str, ...]] = {
    "tool": ("tool_call",),
    "chat": ("message",),
    "error": ("error",),
    "compaction": ("compaction",),
    "steering": ("steering",),
}

# Feed kinds produced by the fact graph itself (facts/intents/hints tables). Note that
# project_activity can also carry these kinds (e.g. intent claim events), so a `kinds`
# filter is applied to both sources.
GRAPH_FEED_KINDS = ("fact", "goal", "intent", "hint")

# ---------------------------------------------------------------- worker observability
# Dispatcher worker runs (R3.2b). ``worker_run`` is the lifecycle row; the rest are the
# transcript pi actually emitted. They live in project_activity with a non-null run_id and
# are served both by the generic /activity feed and by /projects/{id}/workers.
WORKER_RUN = "worker_run"
WORKER_CHILD_KINDS = (
    "worker_thinking",
    "tool_call",
    "tool_result",
    "worker_message",
    "worker_error",
    "worker_output",
)
WORKER_ACTIVITY_KINDS = (WORKER_RUN, *WORKER_CHILD_KINDS)
WORKER_OPEN_STATUSES = ("running", "streaming")
WORKER_TERMINAL_STATUSES = ("success", "failed", "timeout", "cancelled", "error", "stopped")

# Cursor sentinel for rows without a timestamp. Facts have no created_at, so their feed
# entry can only be placed after every timestamped row. The sentinel keeps them reachable
# with a stable, non-null cursor.
NULL_TS_SENTINEL = "~"


def now_fractional() -> str:
    """UTC timestamp with microseconds, comparable with ``expires_at`` values."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")



def _clip(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    if len(value) <= limit:
        return value
    return value[:limit] + f"…[truncated {len(value) - limit} chars]"


def _dumps(value: Any, limit: int = MAX_RAW_JSON) -> str | None:
    if value is None:
        return None
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = repr(value)
    return _clip(text, limit)


# ------------------------------------------------------------------ project events


def record_activity(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    kind: str,
    title: str,
    description: str | None = None,
    actor: str | None = None,
    status: str | None = None,
    metadata: dict[str, Any] | None = None,
    source: str = "server",
    created_at: str | None = None,
    run_id: str | None = None,
) -> int:
    """Append one event to ``project_activity`` (caller owns the transaction)."""
    cursor = conn.execute(
        """
        INSERT INTO project_activity
            (project_id, kind, actor, status, title, description, metadata, source,
             created_at, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            kind,
            actor,
            status,
            title,
            description,
            _dumps(metadata),
            source,
            created_at or utcnow(),
            run_id,
        ),
    )
    return int(cursor.lastrowid)


def record_activity_safe(project_id: str, **fields: Any) -> None:
    """Best-effort variant for call sites that must never fail (dispatcher hooks)."""
    try:
        with get_conn() as conn:
            record_activity(conn, project_id, **fields)
    except Exception:  # pragma: no cover - defensive, never break the caller
        pass


# ------------------------------------------------------------------- approvals


def expire_pending_approvals(
    conn: sqlite3.Connection, project_id: str | None = None
) -> int:
    """Mark every due ``pending`` approval as ``expired`` (idempotent, bulk).

    This runs on every read path that reports approvals (queue, overview, project
    detail, chat context) instead of relying on the first per-row read. Timestamps are
    compared on the ``YYYY-MM-DDTHH:MM:SS`` prefix so legacy rows without microseconds
    and rows with microseconds expire consistently.

    Returns the number of approvals transitioned.
    """
    now = utcnow()
    now_prefix = now[:19]
    query = (
        "SELECT * FROM approval_requests WHERE status = 'pending' "
        "AND expires_at IS NOT NULL AND substr(expires_at, 1, 19) <= ?"
    )
    params: list[Any] = [now_prefix]
    if project_id is not None:
        query += " AND project_id = ?"
        params.append(project_id)
    expired = 0
    for row in conn.execute(query, params).fetchall():
        cursor = conn.execute(
            "UPDATE approval_requests SET status = 'expired', decided_at = ? "
            "WHERE id = ? AND status = 'pending'",
            (now, row["id"]),
        )
        if int(cursor.rowcount or 0) != 1:
            # Another writer won the race; it owns the transition and its activity row.
            continue
        expired += 1
        if row["project_id"]:
            record_activity(
                conn,
                row["project_id"],
                kind="approval",
                title=f"Approval expired: {row['action']}",
                description=row["payload"],
                actor="system",
                status="expired",
                metadata={"approval_id": row["id"], "action": row["action"]},
                created_at=now,
            )
    return expired


# ---------------------------------------------------------------- chat activities


def _message_text(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def _tool_result_text(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if not isinstance(result, dict):
        return _dumps(result) or ""
    content = result.get("content")
    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif item.get("type") == "image":
                parts.append("[image]")
    if not parts and result.get("details") is not None:
        parts.append(_dumps(result.get("details")) or "")
    return "\n".join(part for part in parts if part)


def _usage_numbers(message: Any) -> tuple[int, int, dict[str, Any] | None]:
    if not isinstance(message, dict):
        return 0, 0, None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return 0, 0, None
    try:
        tokens_in = int(usage.get("input") or 0)
        tokens_out = int(usage.get("output") or 0)
    except (TypeError, ValueError):
        return 0, 0, None
    return tokens_in, tokens_out, usage


class ChatActivityRecorder:
    """Persist one pi turn's JSON event stream as ``chat_activities`` rows."""

    def __init__(
        self,
        conversation_id: int,
        run_id: str,
        *,
        user_message_id: int | None = None,
        assistant_message_id: int | None = None,
    ) -> None:
        self.conversation_id = conversation_id
        self.run_id = run_id
        self.user_message_id = user_message_id
        self.assistant_message_id = assistant_message_id
        self.seq = 0
        self.events = 0
        self.turns = 0
        self.tool_calls = 0
        self.tokens_in = 0
        self.tokens_out = 0
        self.model: str | None = None
        self._seq_loaded = False
        self._stream_row: int | None = None
        self._text_blocks: dict[int, str] = {}
        self._thinking: dict[int, tuple[int, list[str]]] = {}
        self._tool_rows: dict[str, int] = {}
        self._last_flush = 0.0
        self.last_text: str = ""

    # -- plumbing ---------------------------------------------------------
    def _load_seq(self, *, force: bool = False) -> None:
        if self._seq_loaded and not force:
            return
        self._seq_loaded = True
        with get_conn() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) AS seq FROM chat_activities WHERE conversation_id = ?",
                (self.conversation_id,),
            ).fetchone()
        self.seq = int(row["seq"] if row is not None else 0)

    def _message_link(self, role: str | None) -> int | None:
        if role == "user":
            return self.user_message_id
        return self.assistant_message_id

    def bind_messages(
        self, *, user_message_id: int | None = None, assistant_message_id: int | None = None
    ) -> None:
        """Attach the message ids once the run rows exist (RPC sessions outlive turns)."""
        self.user_message_id = user_message_id
        self.assistant_message_id = assistant_message_id

    def note_steering(self, message: str, *, status: str = "queued", error: str | None = None) -> int:
        """Record a mid-turn steering message that pi accepted into its queue."""
        # Re-read MAX(seq): the live turn recorder is the primary seq owner, but a steer can
        # be written from another coroutine while it is streaming.
        self._load_seq(force=True)
        return self._insert(
            "steering",
            role="user",
            content=message,
            status=status,
            error=error,
            raw={"source": "cairn.chat.steer", "status": status},
        )

    def last_assistant_text(self) -> str:
        """Last assistant text seen by this recorder (fallback for RPC turns)."""
        return self.last_text

    def last_run_assistant_text(self) -> str:
        """Last assistant text *of this run*: completed message, else the streamed partial.

        Used when a turn is stopped mid-stream: pi never emitted ``message_end``, so the
        only real text is what the recorder persisted for this ``run_id``. Never reads
        another run (and never the session-wide ``get_last_assistant_text``).
        """
        if self.last_text:
            return self.last_text
        try:
            with get_conn() as conn:
                row = conn.execute(
                    "SELECT content FROM chat_activities "
                    "WHERE run_id = ? AND kind = 'message' AND role = 'assistant' "
                    "AND content IS NOT NULL AND content != '' "
                    "ORDER BY id DESC LIMIT 1",
                    (self.run_id,),
                ).fetchone()
        except sqlite3.Error:  # pragma: no cover - defensive
            return ""
        return str(row["content"]) if row is not None else ""

    def note_session(self, session_id: str) -> int:
        """Record the pi session that served this turn.

        RPC mode has no ``session`` header record, so the serving session id is read from
        ``get_state`` and recorded here (never invented).
        """
        return self._insert("session", content=session_id, status="done", raw={"source": "pi.rpc.get_state"})

    def _insert(
        self,
        kind: str,
        *,
        role: str | None = None,
        content: str | None = None,
        tool_name: str | None = None,
        tool_call_id: str | None = None,
        tool_input: str | None = None,
        tool_output: str | None = None,
        status: str = "done",
        error: str | None = None,
        tokens_in: int | None = None,
        tokens_out: int | None = None,
        raw: Any = None,
    ) -> int:
        self._load_seq()
        self.seq += 1
        with get_conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO chat_activities
                    (conversation_id, message_id, run_id, seq, kind, role, content,
                     tool_name, tool_call_id, tool_input, tool_output, status, error,
                     tokens_in, tokens_out, created_at, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    self.conversation_id,
                    self._message_link(role),
                    self.run_id,
                    self.seq,
                    kind,
                    role,
                    _clip(content, MAX_CONTENT),
                    tool_name,
                    tool_call_id,
                    _clip(tool_input, MAX_TOOL_OUTPUT),
                    _clip(tool_output, MAX_TOOL_OUTPUT),
                    status,
                    error,
                    tokens_in,
                    tokens_out,
                    utcnow(),
                    _dumps(raw),
                ),
            )
            return int(cursor.lastrowid)

    def _update(self, row_id: int, **fields: Any) -> None:
        if not fields:
            return
        assignments = []
        values: list[Any] = []
        for key, value in fields.items():
            if key in ("content", "tool_output"):
                value = _clip(value, MAX_CONTENT if key == "content" else MAX_TOOL_OUTPUT)
            elif key == "raw_json":
                key = "raw_json"
                value = _dumps(value)
            assignments.append(f"{key} = ?")
            values.append(value)
        values.append(row_id)
        with get_conn() as conn:
            conn.execute(
                f"UPDATE chat_activities SET {', '.join(assignments)} WHERE id = ?", values
            )

    # -- event handling ---------------------------------------------------
    def feed_event(self, event: dict[str, Any]) -> None:
        """Handle one already-decoded pi event (RPC mode delivers objects, not lines)."""
        if not isinstance(event, dict):
            return
        self.events += 1
        self._handle(event)

    def feed_line(self, line: str) -> bool:
        """Handle one JSONL line from pi. Returns True when it was a JSON event."""
        text = line.strip()
        if not text:
            return False
        try:
            event = json.loads(text)
        except json.JSONDecodeError:
            self._insert(
                "raw",
                content=text,
                status="unknown",
                raw={"source": "pi.stdout", "raw": text},
            )
            return False
        if not isinstance(event, dict):
            self._insert("raw", content=text, status="unknown", raw={"source": "pi.stdout"})
            return False
        self.events += 1
        self._handle(event)
        return True

    def _handle(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if not isinstance(kind, str) or not kind:
            self._insert("event", content=json.dumps(event, ensure_ascii=False)[:500], raw=event)
            return

        if kind == "session":
            self._insert("session", content=event.get("id"), status="done", raw=event)
            return
        if kind == "agent_start":
            self._insert("agent_start", raw=event)
            return
        if kind == "agent_settled":
            # An aborted settle is a stop, not an error: the turn was cancelled on purpose.
            status = "stopped" if event.get("aborted") else "done"
            self._insert("agent_settled", status=status, raw=event)
            return
        if kind == "turn_start":
            self.turns += 1
            self._insert("turn_start", raw=event)
            return
        if kind == "turn_end":
            message = event.get("message")
            tool_results = event.get("toolResults")
            meta = {
                "tool_results": len(tool_results) if isinstance(tool_results, list) else 0,
            }
            if isinstance(message, dict):
                meta["stop_reason"] = message.get("stopReason")
                meta["role"] = message.get("role")
            self._insert("turn_end", raw=meta)
            return
        if kind == "agent_end":
            messages = event.get("messages")
            self._insert(
                "agent_end",
                status="done",
                raw={"messages": len(messages) if isinstance(messages, list) else 0,
                     "willRetry": event.get("willRetry")},
            )
            return
        if kind == "message_start":
            self._message_start(event.get("message"))
            return
        if kind == "message_update":
            self._message_update(event)
            return
        if kind == "message_end":
            self._message_end(event.get("message"))
            return
        if kind == "tool_execution_start":
            self._tool_start(event)
            return
        if kind == "tool_execution_update":
            self._tool_update(event)
            return
        if kind == "tool_execution_end":
            self._tool_end(event)
            return
        if kind == "compaction_start":
            self._insert(
                "compaction",
                content=str(event.get("reason") or "compaction"),
                status="running",
                raw=event,
            )
            return
        if kind == "compaction_end":
            result = event.get("result")
            summary = ""
            if isinstance(result, dict):
                summary = str(result.get("summary") or result.get("tokensBefore") or "")
            status = "error" if event.get("errorMessage") else "done"
            self._insert(
                "compaction",
                content=summary or str(event.get("reason") or "compaction"),
                status=status,
                error=event.get("errorMessage"),
                raw=event,
            )
            return
        if kind in ("auto_retry_start", "summarization_retry_scheduled",
                    "summarization_retry_attempt_start"):
            self._insert("retry", status="running", raw=event)
            return
        if kind in ("auto_retry_end", "summarization_retry_finished"):
            status = "error" if event.get("success") is False or event.get("finalError") else "done"
            self._insert("retry", status=status, error=event.get("finalError"), raw=event)
            return
        if kind == "queue_update":
            steering = event.get("steering") or []
            follow_up = event.get("followUp") or []
            self._insert(
                "queue",
                content=_dumps({"steering": steering, "followUp": follow_up}),
                raw=event,
            )
            return
        if kind == "bash_execution_update":
            return
        if kind == "entry_appended":
            entry = event.get("entry")
            entry_type = entry.get("type") if isinstance(entry, dict) else None
            custom_type = entry.get("customType") if isinstance(entry, dict) else None
            self._insert(
                "session_entry",
                content=custom_type or entry_type or "entry",
                status="info",
                raw={"entry_type": entry_type, "customType": custom_type,
                     "id": entry.get("id") if isinstance(entry, dict) else None},
            )
            return
        if kind == "session_info_changed":
            self._insert("session_info", content=event.get("name"), status="info", raw=event)
            return
        if kind == "thinking_level_changed":
            self._insert("thinking_level", content=event.get("level"), status="info", raw=event)
            return
        if kind == "raw":
            # Transport contamination forwarded by the RPC reader (stdout that is not a
            # protocol record). Kept verbatim but bounded, never interpreted.
            self._insert(
                "raw",
                content=str(event.get("raw") or "")[:4_000],
                status="unknown",
                raw={"source": event.get("source")},
            )
            return
        if kind == "extension_ui_request":
            # RPC mode routes extension UI through stdout. Dialog requests are answered by
            # the session manager (cancelled) and status/widget plumbing is not conversation
            # content, so only user-facing notifications are persisted.
            if event.get("method") == "notify":
                self._insert(
                    "notify",
                    content=event.get("message"),
                    status="info",
                    raw={"method": "notify", "notifyType": event.get("notifyType")},
                )
            return
        if kind == "extension_error":
            self._insert(
                "error",
                status="error",
                error=str(event.get("error") or "extension error"),
                content=str(event.get("event") or ""),
                raw=event,
            )
            return
        # Unknown but real: keep it so nothing is silently dropped.
        self._insert("event", content=str(kind), status="unknown", raw=event)

    def _message_start(self, message: Any) -> None:
        role = message.get("role") if isinstance(message, dict) else None
        if role == "assistant":
            self._text_blocks = {}
            self._thinking = {}
            self._stream_row = self._insert(
                "message",
                role="assistant",
                content="",
                status="streaming",
                raw={"model": message.get("model"), "provider": message.get("provider"),
                     "timestamp": message.get("timestamp")},
            )
            if isinstance(message.get("model"), str):
                self.model = message["model"]
            return
        self._insert(
            "message",
            role=str(role or "unknown"),
            content=_message_text(message),
            status="done",
            raw={"timestamp": message.get("timestamp")} if isinstance(message, dict) else None,
        )

    def _current_stream_row(self) -> int | None:
        if self._stream_row is not None:
            return self._stream_row
        # A delta arrived without message_start (e.g. resumed output): start one.
        self._text_blocks = {}
        self._stream_row = self._insert(
            "message", role="assistant", content="", status="streaming",
        )
        return self._stream_row

    def _flush_stream(self, force: bool = False) -> None:
        row = self._stream_row
        if row is None:
            return
        now = time.monotonic()
        if not force and now - self._last_flush < STREAM_FLUSH_SECONDS:
            return
        self._last_flush = now
        self._update(row, content=self._stream_text())

    def _stream_text(self) -> str:
        return "".join(self._text_blocks[index] for index in sorted(self._text_blocks))

    def _message_update(self, event: dict[str, Any]) -> None:
        ame = event.get("assistantMessageEvent")
        if not isinstance(ame, dict):
            return
        atype = ame.get("type")
        if atype in ("text_delta", "text_start", "text_end"):
            index = int(ame.get("contentIndex") or 0)
            self._current_stream_row()
            if atype == "text_delta" and isinstance(ame.get("delta"), str):
                self._text_blocks[index] = self._text_blocks.get(index, "") + ame["delta"]
                self._flush_stream()
            elif atype == "text_end" and isinstance(ame.get("content"), str):
                # Authoritative text for this block replaces accumulated deltas.
                self._text_blocks[index] = ame["content"]
                self._flush_stream(force=True)
            return
        if atype in ("thinking_start", "thinking_delta", "thinking_end"):
            index = int(ame.get("contentIndex") or 0)
            row, parts = self._thinking.get(index, (None, []))
            if row is None:
                row = self._insert("thinking", role="assistant", content="", status="streaming")
                self._thinking[index] = (row, parts)
            if atype == "thinking_delta" and isinstance(ame.get("delta"), str):
                parts.append(ame["delta"])
            elif atype == "thinking_end" and isinstance(ame.get("content"), str):
                parts[:] = [ame["content"]]
            self._thinking[index] = (row, parts)
            now = time.monotonic()
            if atype == "thinking_end" or now - self._last_flush >= STREAM_FLUSH_SECONDS:
                self._last_flush = now
                self._update(row, content="".join(parts),
                             status="done" if atype == "thinking_end" else "streaming")
            if atype == "thinking_end":
                self._thinking.pop(index, None)
            return
        if atype == "toolcall_end":
            # Execution events carry the authoritative call; nothing to persist here.
            return
        if atype == "error":
            error_message = None
            if isinstance(ame.get("error"), dict):
                error_message = ame["error"].get("errorMessage")
            self._insert(
                "error",
                role="assistant",
                status="error",
                error=str(error_message or ame.get("reason") or "pi message error"),
                raw=ame,
            )
            return
        if atype == "done":
            return

    def _message_end(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        role = message.get("role")
        if role != "assistant":
            return
        text = _message_text(message)
        stop_reason = message.get("stopReason")
        status = "done"
        error = None
        if stop_reason in ("error", "aborted"):
            status = "error" if stop_reason == "error" else "stopped"
            error = message.get("errorMessage") or f"pi stopReason={stop_reason}"
        tokens_in, tokens_out, usage = _usage_numbers(message)
        row = self._stream_row
        if row is None:
            row = self._insert(
                "message",
                role="assistant",
                content=text,
                status=status,
                error=error,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                raw={"usage": usage, "stopReason": stop_reason},
            )
        else:
            self._update(
                row,
                content=text,
                status=status,
                error=error,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                raw_json={"usage": usage, "stopReason": stop_reason,
                          "model": message.get("model")},
            )
        if isinstance(message.get("model"), str):
            self.model = message["model"]
        if usage is not None:
            self.tokens_in += tokens_in
            self.tokens_out += tokens_out
            self._insert(
                "usage",
                role="assistant",
                status="done",
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                content=_dumps({"input": usage.get("input"), "output": usage.get("output"),
                                "cacheRead": usage.get("cacheRead"),
                                "cacheWrite": usage.get("cacheWrite"),
                                "totalTokens": usage.get("totalTokens"),
                                "cost": usage.get("cost")}),
                raw={"usage": usage},
            )
        if status != "done":
            # ``stopped`` is a normal outcome of an aborted turn: the message row already
            # carries that status and an extra ``error`` activity would mislabel it.
            if status == "error":
                self._insert("error", role="assistant", status=status, error=error, raw={
                    "stopReason": stop_reason, "errorMessage": message.get("errorMessage"),
                })
        if text:
            self.last_text = text
        self._stream_row = None
        self._text_blocks = {}

    def _tool_start(self, event: dict[str, Any]) -> None:
        call_id = str(event.get("toolCallId") or "")
        tool_name = str(event.get("toolName") or "unknown")
        self.tool_calls += 1
        row = self._insert(
            "tool_call",
            role="assistant",
            tool_name=tool_name,
            tool_call_id=call_id,
            tool_input=_dumps(event.get("args")),
            status="running",
            raw={"parentToolCallId": event.get("parentToolCallId")} if event.get("parentToolCallId") else None,
        )
        self._tool_rows[call_id] = row

    def _tool_update(self, event: dict[str, Any]) -> None:
        call_id = str(event.get("toolCallId") or "")
        row = self._tool_rows.get(call_id)
        if row is None:
            return
        now = time.monotonic()
        if now - self._last_flush < STREAM_FLUSH_SECONDS:
            return
        self._last_flush = now
        text = _tool_result_text(event.get("partialResult"))
        if text:
            self._update(row, tool_output=text)

    def _tool_end(self, event: dict[str, Any]) -> None:
        call_id = str(event.get("toolCallId") or "")
        is_error = bool(event.get("isError"))
        output = _tool_result_text(event.get("result"))
        error = output if is_error else None
        row = self._tool_rows.pop(call_id, None)
        raw = {"durationMs": event.get("durationMs")}
        if event.get("parentToolCallId"):
            raw["parentToolCallId"] = event.get("parentToolCallId")
        if row is None:
            self._insert(
                "tool_call",
                role="assistant",
                tool_name=str(event.get("toolName") or "unknown"),
                tool_call_id=call_id,
                tool_input=_dumps(event.get("args")),
                tool_output=output,
                status="error" if is_error else "done",
                error=error,
                raw=raw,
            )
            return
        self._update(
            row,
            tool_output=output,
            status="error" if is_error else "done",
            error=error,
            raw_json=raw,
        )

    # -- lifecycle --------------------------------------------------------
    def note_run_failure(self, error: str) -> None:
        """Record a run-level failure the server observed (pi emitted no events)."""
        self._insert(
            "error",
            status="error",
            error=error,
            content=error,
            raw={"source": "cairn.server", "reason": "pi produced no JSON events"},
        )

    def finish(self, status: str, error: str | None = None) -> dict[str, Any]:
        """Close any still-open rows for this run and return the run summary."""
        self._flush_stream(force=True)
        for index, (row, parts) in list(self._thinking.items()):
            self._update(row, content="".join(parts), status="done")
            self._thinking.pop(index, None)
        open_status = {"stopped": "stopped", "error": "error"}.get(status, "done")
        try:
            with get_conn() as conn:
                conn.execute(
                    f"""
                    UPDATE chat_activities
                    SET status = ?, error = COALESCE(error, ?)
                    WHERE conversation_id = ? AND run_id = ?
                      -- steering rows record the acceptance of a mid-turn message; their
                      -- status is not a run state and must not be rewritten on completion.
                      AND kind != 'steering'
                      AND status IN ({",".join("?" for _ in OPEN_STATUSES)})
                    """,
                    (open_status, error, self.conversation_id, self.run_id, *OPEN_STATUSES),
                )
        except sqlite3.Error:
            pass
        return {
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "turns": self.turns,
            "tool_calls": self.tool_calls,
            "model": self.model,
            "events": self.events,
        }


def close_open_activities(
    conn: sqlite3.Connection,
    conversation_id: int,
    *,
    status: str,
    error: str | None = None,
    run_id: str | None = None,
) -> int:
    """Mark in-flight activities as stopped/failed (stop, timeout, stale reconcile)."""
    query = (
        "UPDATE chat_activities SET status = ?, error = COALESCE(error, ?) "
        "WHERE conversation_id = ? AND kind != 'steering' AND status IN "
        f"({', '.join('?' for _ in OPEN_STATUSES)})"
    )
    params: list[Any] = [status, error, conversation_id, *OPEN_STATUSES]
    if run_id is not None:
        query += " AND run_id = ?"
        params.append(run_id)
    cursor = conn.execute(query, params)
    return int(cursor.rowcount or 0)


# --------------------------------------------------------------------- feed


def _parse_cursor(after: str | None) -> tuple[str, str] | None:
    """Parse ``"<ts>#<id>"`` or the null-timestamp sentinel ``"~#<id>"``."""
    if not after:
        return None
    ts, sep, item_id = after.partition("#")
    if not sep or not ts or not item_id:
        return None
    return (ts, item_id)


SortKey = tuple[int, str, str, int, int, str]


def _id_key(item_id: str) -> tuple[str, int, int, str]:
    """Order ``event:9`` before ``event:10`` (string ids would put 10 first)."""
    prefix, _, suffix = item_id.partition(":")
    if suffix.isdigit():
        return (prefix, 0, int(suffix), suffix)
    return (prefix, 1, 0, suffix)


def _sort_key(item: dict[str, Any]) -> SortKey:
    timestamp = item.get("timestamp")
    prefix, rank, number, suffix = _id_key(str(item["id"]))
    if timestamp is None:
        return (1, "", prefix, rank, number, suffix)
    return (0, timestamp, prefix, rank, number, suffix)


def _cursor_key(cursor: tuple[str, str]) -> SortKey:
    ts, item_id = cursor
    prefix, rank, number, suffix = _id_key(item_id)
    if ts == NULL_TS_SENTINEL:
        return (1, "", prefix, rank, number, suffix)
    return (0, ts, prefix, rank, number, suffix)


def _feed_item(
    *,
    project_id: str,
    item_id: str,
    kind: str,
    source: str,
    title: str,
    timestamp: str | None,
    timestamp_source: str,
    actor: str | None = None,
    status: str | None = None,
    description: str | None = None,
    metadata: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "id": item_id,
        "project_id": project_id,
        "timestamp": timestamp,
        "timestamp_source": timestamp_source,
        "actor": actor,
        "status": status,
        "title": title,
        "description": description,
        "metadata": metadata or {},
        "source": source,
        # Worker transcript only (project_activity.run_id); chat run ids stay in metadata.
        "run_id": run_id,
        # Always present: a row without a timestamp still gets a stable, total-order
        # cursor so pagination can never dead-end on ``has_more=true, next_cursor=null``.
        "cursor": f"{timestamp}#{item_id}" if timestamp else f"{NULL_TS_SENTINEL}#{item_id}",
    }



def _fact_items(conn: sqlite3.Connection, project_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT f.id, f.description,
               (SELECT i.concluded_at FROM intents i
                 WHERE i.project_id = f.project_id AND i.to_fact_id = f.id
                 ORDER BY i.concluded_at DESC LIMIT 1) AS concluded_at,
               (SELECT i.worker FROM intents i
                 WHERE i.project_id = f.project_id AND i.to_fact_id = f.id
                 ORDER BY i.concluded_at DESC LIMIT 1) AS worker
        FROM facts f WHERE f.project_id = ?
        ORDER BY f.rowid
        """,
        (project_id,),
    ).fetchall()
    items = []
    for row in rows:
        timestamp = row["concluded_at"]
        items.append(
            _feed_item(
                project_id=project_id,
                item_id=f"fact:{row['id']}",
                kind="goal" if row["id"] == "goal" else "fact",
                source="facts",
                title=f"Fact {row['id']}",
                description=row["description"],
                timestamp=timestamp,
                timestamp_source="intent.concluded_at" if timestamp else "unknown",
                actor=row["worker"],
                status="confirmed",
                metadata={
                    "fact_id": row["id"],
                    "timestamp_note": None if timestamp else
                    "facts have no created_at; no producing intent records one",
                },
            )
        )
    return items


def _intent_items(conn: sqlite3.Connection, project_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM intents WHERE project_id = ? ORDER BY created_at, rowid",
        (project_id,),
    ).fetchall()
    items = []
    for row in rows:
        if row["to_fact_id"] is not None:
            status = "concluded"
        elif row["worker"] is not None:
            status = "working"
        else:
            status = "open"
        sources = [
            r["fact_id"]
            for r in conn.execute(
                "SELECT fact_id FROM intent_sources WHERE intent_id = ? AND project_id = ? ORDER BY rowid",
                (row["id"], project_id),
            ).fetchall()
        ]
        items.append(
            _feed_item(
                project_id=project_id,
                item_id=f"intent:{row['id']}",
                kind="intent",
                source="intents",
                title=f"Intent {row['id']}",
                description=row["description"],
                timestamp=row["created_at"],
                timestamp_source="intent.created_at",
                actor=row["worker"] or row["creator"],
                status=status,
                metadata={
                    "intent_id": row["id"],
                    "from": sources,
                    "to": row["to_fact_id"],
                    "worker": row["worker"],
                    "creator": row["creator"],
                    "priority": row["priority"] if "priority" in row.keys() else 0,
                    "concluded_at": row["concluded_at"],
                },
            )
        )
    return items


def _hint_items(conn: sqlite3.Connection, project_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM hints WHERE project_id = ? ORDER BY created_at, rowid", (project_id,)
    ).fetchall()
    return [
        _feed_item(
            project_id=project_id,
            item_id=f"hint:{row['id']}",
            kind="hint",
            source="hints",
            title=f"Hint {row['id']}",
            description=row["content"],
            timestamp=row["created_at"],
            timestamp_source="hint.created_at",
            actor=row["creator"],
            status="added",
            metadata={"hint_id": row["id"], "creator": row["creator"]},
        )
        for row in rows
    ]


def _after_sql_id(item_id: str, prefix: str) -> int:
    """Numeric tie-break id when the cursor item belongs to this source, else 0."""
    if item_id.startswith(prefix):
        try:
            return int(item_id[len(prefix):])
        except ValueError:
            return 0
    return 0


def _metadata(row: sqlite3.Row) -> dict[str, Any]:
    if not row["metadata"]:
        return {}
    try:
        data = json.loads(row["metadata"])
    except json.JSONDecodeError:
        return {"raw": row["metadata"]}
    return data if isinstance(data, dict) else {"raw": data}


def project_activity_item(row: sqlite3.Row, project_id: str) -> dict[str, Any]:
    metadata = _metadata(row)
    metadata.setdefault("activity_id", row["id"])
    return _feed_item(
        project_id=project_id,
        item_id=f"event:{row['id']}",
        kind=row["kind"],
        source=row["source"],
        title=row["title"],
        description=row["description"],
        timestamp=row["created_at"],
        timestamp_source="project_activity.created_at",
        actor=row["actor"],
        status=row["status"],
        metadata=metadata,
        run_id=row["run_id"] if "run_id" in row.keys() else None,
    )


def _event_items(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    after_ts: str | None,
    after_id: int = 0,
    fetch_limit: int,
    sql_kinds: list[str] | None = None,
    descending: bool = False,
) -> list[dict[str, Any]]:
    query = (
        "SELECT * FROM project_activity WHERE project_id = ? "
        # created_at has second resolution: rows sharing the cursor's second must not be
        # skipped, so the id is used as the tie-break inside the same timestamp.
        "AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))"
    )
    params: list[Any] = [project_id, after_ts, after_ts, after_ts, after_id]
    if sql_kinds is not None:
        if not sql_kinds:
            return []
        query += f" AND kind IN ({', '.join('?' for _ in sql_kinds)})"
        params.extend(sql_kinds)
    # For "newest N" the SQL must take the newest rows; ordering ascending and slicing in
    # Python would only ever see the oldest `fetch_limit` rows of a large project.
    query += " ORDER BY created_at DESC, id DESC" if descending else " ORDER BY created_at, id"
    query += " LIMIT ?"
    params.append(fetch_limit)
    rows = conn.execute(query, params).fetchall()
    return [project_activity_item(row, project_id) for row in rows]


def _chat_items(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    after_ts: str | None,
    after_id: int = 0,
    fetch_limit: int,
    sql_kinds: list[str] | None = None,
    descending: bool = False,
) -> list[dict[str, Any]]:
    # The filter runs in SQL, before the fetch limit, so a narrow kind selection is never
    # starved by chat rows of other kinds.
    kinds = list(sql_kinds) if sql_kinds is not None else list(FEED_CHAT_KINDS)
    if not kinds:
        return []
    placeholders = ", ".join("?" for _ in kinds)
    query = f"""
        SELECT a.*, c.project_id AS project_id
        FROM chat_activities a
        JOIN chat_conversations c ON c.id = a.conversation_id
        WHERE c.project_id = ?
          AND a.kind IN ({placeholders})
          AND (a.role IS NULL OR a.role != 'system')
          AND (? IS NULL OR a.created_at > ? OR (a.created_at = ? AND a.id > ?))
        ORDER BY {'a.created_at DESC, a.id DESC' if descending else 'a.created_at, a.id'}
        LIMIT ?
    """
    rows = conn.execute(
        query, (project_id, *kinds, after_ts, after_ts, after_ts, after_id, fetch_limit)
    ).fetchall()
    items = []
    for row in rows:
        kind = (
            "tool" if row["kind"] == "tool_call"
            else ("chat" if row["kind"] == "message" else row["kind"])
        )
        title = (
            f"Tool {row['tool_name']}" if row["kind"] == "tool_call" else
            ("Chat error" if row["kind"] == "error" else
             ("Compaction" if row["kind"] == "compaction" else
              ("Chat steering" if row["kind"] == "steering" else "Chat message")))
        )
        description = row["content"] or (row["tool_input"] if row["kind"] == "tool_call" else None)
        items.append(
            _feed_item(
                project_id=project_id,
                item_id=f"chat:{row['id']}",
                kind=kind,
                source="chat",
                title=title,
                description=_clip(description, 500),
                timestamp=row["created_at"],
                timestamp_source="chat_activities.created_at",
                actor=row["role"] or "mainagent",
                status=row["status"],
                metadata={
                    "activity_id": row["id"],
                    "conversation_id": row["conversation_id"],
                    "message_id": row["message_id"],
                    "run_id": row["run_id"],
                    "tool_name": row["tool_name"],
                    "tool_call_id": row["tool_call_id"],
                    "tool_input": _clip(row["tool_input"], 2_000),
                    "tool_output": _clip(row["tool_output"], 2_000),
                    "error": row["error"],
                    "tokens_in": row["tokens_in"],
                    "tokens_out": row["tokens_out"],
                },
            )
        )
    return items


def _epoch(value: str | None) -> float | None:
    if not value:
        return None
    text = value
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _int_number(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _cost_number(value: Any) -> float:
    if isinstance(value, dict):
        value = value.get("total") or value.get("cost") or 0
    if isinstance(value, bool):
        return 0.0
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def normalize_usage(value: Any) -> dict[str, Any]:
    """Return a complete TokenUsage-shaped dict from a pi ``usage`` object."""
    if not isinstance(value, dict):
        return {
            "input": 0,
            "output": 0,
            "cache_read": 0,
            "cache_write": 0,
            "reasoning": 0,
            "total_tokens": 0,
            "cost": 0.0,
        }
    return {
        "input": _int_number(value.get("input")),
        "output": _int_number(value.get("output")),
        "cache_read": _int_number(value.get("cacheRead", value.get("cache_read"))),
        "cache_write": _int_number(value.get("cacheWrite", value.get("cache_write"))),
        "reasoning": _int_number(value.get("reasoning")),
        "total_tokens": _int_number(value.get("totalTokens", value.get("total_tokens"))),
        "cost": _cost_number(value.get("cost")),
    }


def add_usage(total: dict[str, Any], value: Any) -> dict[str, Any]:
    one = normalize_usage(value)
    for key in ("input", "output", "cache_read", "cache_write", "reasoning", "total_tokens"):
        total[key] = int(total.get(key, 0)) + int(one[key])
    total["cost"] = float(total.get("cost", 0.0)) + float(one["cost"])
    return total


def _run_usage(rows: list[sqlite3.Row], meta: dict[str, Any]) -> dict[str, Any]:
    """Per-run usage: the finish metadata block, else sum of message_end usages.

    The finish block is authoritative so a run's usage survives later transcript
    truncation/pruning; older runs that predate the aggregation are recomputed from the
    ``worker_message`` rows that already carried pi's usage.
    """
    if isinstance(meta.get("usage"), dict):
        return normalize_usage(meta["usage"])
    total = normalize_usage(None)
    for row in rows:
        if row["kind"] != "worker_message":
            continue
        usage = _metadata(row).get("usage")
        if isinstance(usage, dict):
            add_usage(total, usage)
    return total


def _run_model(rows: list[sqlite3.Row], meta: dict[str, Any]) -> str | None:
    model = _str_or_none(meta.get("model"))
    if model:
        return model
    for row in reversed(rows):
        if row["kind"] != "worker_message":
            continue
        candidate = _str_or_none(_metadata(row).get("model"))
        if candidate:
            return candidate
    return None


def _worker_item(
    project_id: str,
    run_id: str,
    rows: list[sqlite3.Row],
    *,
    now: float,
    stale_after_seconds: int,
    transcript_limit: int,
    include_transcript: bool,
) -> tuple[tuple[str, int], dict[str, Any]]:
    start = next(
        (row for row in rows if row["kind"] == WORKER_RUN and row["status"] in WORKER_OPEN_STATUSES),
        None,
    )
    if start is None:
        start = next((row for row in rows if row["kind"] == WORKER_RUN), None)
    terminal = next(
        (row for row in reversed(rows)
         if row["kind"] == WORKER_RUN and row["status"] not in WORKER_OPEN_STATUSES),
        None,
    )

    meta: dict[str, Any] = _metadata(rows[0])
    for row in rows:
        if row["kind"] == WORKER_RUN:
            meta.update(_metadata(row))

    worker = (
        _str_or_none(start["actor"] if start is not None else None)
        or _str_or_none(rows[0]["actor"])
        or _str_or_none(meta.get("worker"))
        or "unknown"
    )
    task = _str_or_none(meta.get("task"))
    intent_id = _str_or_none(meta.get("intent_id"))
    intent_description = _str_or_none(meta.get("intent_description"))
    status = terminal["status"] if terminal is not None else (
        start["status"] if start is not None else "unknown"
    )
    status = status or "unknown"
    started_at = _str_or_none(meta.get("started_at")) or (start or rows[0])["created_at"]
    finished_at = _str_or_none(meta.get("finished_at")) or (
        terminal["created_at"] if terminal is not None else None
    )
    last_event_at = rows[-1]["created_at"]
    open_run = terminal is None and start is not None
    last_epoch = _epoch(last_event_at)
    stale = bool(
        open_run and last_epoch is not None and now - last_epoch > stale_after_seconds
    )
    active = bool(open_run and not stale)

    error: str | None = None
    if terminal is not None and terminal["status"] not in ("success", "done"):
        error = terminal["description"] or _str_or_none(meta.get("error"))
    if not error and status == "cancelled":
        error = _str_or_none(meta.get("cancel_reason"))
    if not error:
        error_row = next((row for row in reversed(rows) if row["kind"] == "worker_error"), None)
        if error_row is not None:
            error = error_row["description"]

    duration_ms = meta.get("duration_ms")
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, int):
        start_epoch = _epoch(started_at)
        end_epoch = _epoch(finished_at)
        duration_ms = (
            max(0, int((end_epoch - start_epoch) * 1000))
            if start_epoch is not None and end_epoch is not None
            else None
        )

    transcript_rows = [row for row in rows if row["kind"] in WORKER_CHILD_KINDS]
    counts = {
        "activities": len(transcript_rows),
        "thinking": sum(1 for row in transcript_rows if row["kind"] == "worker_thinking"),
        "tool_calls": sum(1 for row in transcript_rows if row["kind"] == "tool_call"),
        "tool_results": sum(1 for row in transcript_rows if row["kind"] == "tool_result"),
        "messages": sum(1 for row in transcript_rows if row["kind"] == "worker_message"),
        "errors": sum(1 for row in transcript_rows if row["kind"] == "worker_error"),
    }
    truncated = len(transcript_rows) > transcript_limit
    transcript = (
        [project_activity_item(row, project_id) for row in transcript_rows[-transcript_limit:]]
        if include_transcript and transcript_limit > 0
        else []
    )

    item = {
        "run_id": run_id,
        "project_id": project_id,
        "worker": worker,
        "task": task,
        "intent_id": intent_id,
        "intent_description": intent_description,
        "status": status,
        "active": active,
        "stale": stale,
        "started_at": started_at,
        "finished_at": finished_at,
        "last_event_at": last_event_at,
        "duration_ms": duration_ms,
        "error": error,
        "session": _str_or_none(meta.get("session")),
        "model": _run_model(rows, meta),
        "usage": _run_usage(rows, meta),
        "transcript_truncated": truncated,
        "counts": counts,
        "transcript": transcript,
    }
    return ((started_at or "", rows[-1]["id"]), item)


def build_worker_run(
    conn: sqlite3.Connection,
    project_id: str,
    run_id: str,
    *,
    transcript_limit: int = 200,
    include_transcript: bool = True,
    stale_after_seconds: int = 900,
) -> dict[str, Any] | None:
    rows = conn.execute(
        "SELECT * FROM project_activity WHERE project_id = ? AND run_id = ? ORDER BY id",
        (project_id, run_id),
    ).fetchall()
    if not rows:
        return None
    _, item = _worker_item(
        project_id,
        run_id,
        list(rows),
        now=time.time(),
        stale_after_seconds=stale_after_seconds,
        transcript_limit=transcript_limit,
        include_transcript=include_transcript,
    )
    return item


def build_project_workers(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    worker: str | None = None,
    run_id: str | None = None,
    exclude_task: str | None = None,
    active_only: bool = False,
    include_transcript: bool = True,
    limit: int = 20,
    transcript_limit: int = 200,
    stale_after_seconds: int = 900,
) -> dict[str, Any]:
    """Active/recent dispatcher worker runs grouped by ``project_activity.run_id``.

    A run is active when it has a ``worker_run`` row in ``running``/``streaming`` status and
    no terminal ``worker_run`` row. If its last event is older than
    ``stale_after_seconds`` it is reported as ``stale`` (and not active) instead of being
    silently rewritten — the row is evidence, not state the server owns.
    """
    query = "SELECT * FROM project_activity WHERE project_id = ? AND run_id IS NOT NULL"
    params: list[Any] = [project_id]
    worker_filter = " AND actor = ?" if worker is not None else ""
    if run_id is not None:
        query += " AND run_id = ?"
        params.append(run_id)
    else:
        # Bound the scan to the runs this page can actually show (plus any still open, so
        # a long-running run older than the recent page is never hidden). Without this a
        # project that has accumulated many worker runs would rescan its whole transcript
        # history on every 1 s UI poll.
        task_filter = (
            " AND json_extract(metadata, '$.task') IS NOT ?" if exclude_task is not None else ""
        )
        task_params = [exclude_task] if exclude_task is not None else []
        recent = conn.execute(
            "SELECT run_id, MAX(id) AS last_id FROM project_activity "
            "WHERE project_id = ? AND run_id IS NOT NULL AND kind = 'worker_run'"
            f"{worker_filter}{task_filter} "
            "GROUP BY run_id ORDER BY last_id DESC LIMIT ?",
            (project_id, *([worker] if worker is not None else []), *task_params, max(limit * 4, 50)),
        ).fetchall()
        open_ids = conn.execute(
            "SELECT DISTINCT run_id FROM project_activity "
            "WHERE project_id = ? AND run_id IS NOT NULL AND kind = 'worker_run'"
            f"{worker_filter}{task_filter} "
            f"AND status IN ({', '.join('?' for _ in WORKER_OPEN_STATUSES)})",
            (project_id, *([worker] if worker is not None else []), *task_params, *WORKER_OPEN_STATUSES),
        ).fetchall()
        run_ids = list(dict.fromkeys([row["run_id"] for row in recent] +
                                     [row["run_id"] for row in open_ids]))
        if not run_ids:
            return {
                "project_id": project_id,
                "generated_at": utcnow(),
                "active_count": 0,
                "items": [],
            }
        query += f" AND run_id IN ({', '.join('?' for _ in run_ids)})"
        params.extend(run_ids)
    query += " ORDER BY id"
    rows = conn.execute(query, params).fetchall()

    grouped: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        grouped.setdefault(row["run_id"], []).append(row)

    now = time.time()
    entries: list[tuple[tuple[str, int], dict[str, Any]]] = []
    for rid, run_rows in grouped.items():
        sort_key, item = _worker_item(
            project_id,
            rid,
            list(run_rows),
            now=now,
            stale_after_seconds=stale_after_seconds,
            transcript_limit=transcript_limit,
            include_transcript=include_transcript,
        )
        if worker is not None and item["worker"] != worker:
            continue
        if active_only and not item["active"]:
            continue
        entries.append((sort_key, item))
    entries.sort(key=lambda entry: entry[0], reverse=True)
    return {
        "project_id": project_id,
        "generated_at": utcnow(),
        "active_count": sum(1 for _, item in entries if item["active"]),
        "items": [item for _, item in entries[:limit]],
    }


def close_worker_run(
    conn: sqlite3.Connection,
    project_id: str,
    run_id: str,
    *,
    status: str,
    error: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> int:
    """Close a worker run: terminalise open child rows and append the finish row once.

    Idempotent: a second call only re-closes any lingering open row and returns the existing
    terminal ``worker_run`` id, so a retried HTTP close can never duplicate the finish.
    """
    rows = conn.execute(
        "SELECT * FROM project_activity WHERE project_id = ? AND run_id = ? ORDER BY id",
        (project_id, run_id),
    ).fetchall()
    start = next((row for row in rows if row["kind"] == WORKER_RUN), None)
    existing = next(
        (row for row in reversed(rows)
         if row["kind"] == WORKER_RUN and row["status"] not in WORKER_OPEN_STATUSES),
        None,
    )
    child_status = {
        "success": "done",
        "failed": "error",
        "timeout": "timeout",
        "cancelled": "cancelled",
        "error": "error",
        "stopped": "stopped",
    }.get(status, "done")
    open_rows = [row for row in rows if row["status"] in WORKER_OPEN_STATUSES]
    conn.execute(
        f"""
        UPDATE project_activity
        SET status = ?
        WHERE project_id = ? AND run_id = ?
          AND status IN ({", ".join("?" for _ in WORKER_OPEN_STATUSES)})
        """,
        (child_status, project_id, run_id, *WORKER_OPEN_STATUSES),
    )
    if error:
        for row in open_rows:
            merged_row = _metadata(row)
            merged_row["error"] = error
            conn.execute(
                "UPDATE project_activity SET metadata = ? WHERE id = ?",
                (_dumps(merged_row), row["id"]),
            )
    if existing is not None:
        return int(existing["id"])
    merged: dict[str, Any] = _metadata(start) if start is not None else {}
    merged.update(metadata or {})
    merged["run_id"] = run_id
    merged.setdefault("finished_at", utcnow())
    task = merged.get("task") or "worker"
    worker = (start["actor"] if start is not None else None) or merged.get("worker") or "worker"
    return record_activity(
        conn,
        project_id,
        kind=WORKER_RUN,
        title=f"{task} worker {worker} finished ({status})",
        description=_clip(error, MAX_CONTENT),
        actor=worker,
        status=status,
        metadata=merged,
        source="dispatcher",
        run_id=run_id,
    )


def update_worker_activity(
    conn: sqlite3.Connection,
    project_id: str,
    activity_id: int,
    *,
    status: str | None = None,
    description: str | None = None,
    error: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> sqlite3.Row | None:
    """Update one worker transcript row. Non-worker rows are rejected by the caller."""
    row = conn.execute(
        "SELECT * FROM project_activity WHERE id = ? AND project_id = ?",
        (activity_id, project_id),
    ).fetchone()
    if row is None:
        return None
    if row["run_id"] is None or row["kind"] not in WORKER_CHILD_KINDS:
        raise ValueError("only worker transcript rows can be updated")
    merged = _metadata(row)
    merged.update(metadata or {})
    merged["run_id"] = row["run_id"]
    if error is not None:
        merged["error"] = error
    conn.execute(
        """
        UPDATE project_activity
        SET status = COALESCE(?, status),
            description = COALESCE(?, description),
            metadata = ?
        WHERE id = ? AND project_id = ?
        """,
        (status, _clip(description, MAX_CONTENT), _dumps(merged), activity_id, project_id),
    )
    return conn.execute(
        "SELECT * FROM project_activity WHERE id = ?", (activity_id,)
    ).fetchone()


def build_project_activity(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    after: str | None = None,
    limit: int = 50,
    kinds: list[str] | None = None,
    newest_first: bool = False,
) -> dict[str, Any]:
    """Merge facts, intents, hints, project events and chat activities chronologically.

    ``newest_first`` returns the *newest* ``limit`` rows (descending) instead of the oldest;
    it is what ``/overview`` reports. Cursor pagination is only defined for the ascending
    feed, and every item carries a non-null cursor (``~#<id>`` when it has no timestamp).
    """
    cursor = _parse_cursor(after)
    after_ts = cursor[0] if cursor and cursor[0] != NULL_TS_SENTINEL else None
    fetch_limit = max(limit * 4, 200)
    event_after_id = _after_sql_id(cursor[1], "event:") if cursor else 0
    chat_after_id = _after_sql_id(cursor[1], "chat:") if cursor else 0

    wanted = set(kinds) if kinds else None

    def wants(kind: str) -> bool:
        return wanted is None or kind in wanted

    # Newest-N reads the newest rows from SQL; the merge below re-sorts ascending anyway.
    descending = newest_first and cursor is None

    event_kinds: list[str] | None = None
    chat_kinds: list[str] | None = None
    if wanted is not None:
        # project_activity can carry any kind (graph-like intent/status rows, worker,
        # steering, approval, ...). The SQL filter therefore uses the requested kinds
        # verbatim and runs before LIMIT; chat activities are filtered by their own
        # mapping (tool -> tool_call, chat -> message, ...).
        event_kinds = sorted(wanted)
        chat_kinds = sorted(
            {sql_kind for feed_kind, sql_kinds in CHAT_FEED_KINDS.items()
             if feed_kind in wanted for sql_kind in sql_kinds}
        )

    items: list[dict[str, Any]] = []
    if wants("fact") or wants("goal"):
        items.extend(item for item in _fact_items(conn, project_id) if wants(item["kind"]))
    if wants("intent"):
        items.extend(_intent_items(conn, project_id))
    if wants("hint"):
        items.extend(_hint_items(conn, project_id))
    if event_kinds is None or event_kinds:
        items.extend(
            _event_items(
                conn,
                project_id,
                after_ts=after_ts,
                after_id=event_after_id,
                fetch_limit=fetch_limit,
                sql_kinds=event_kinds,
                descending=descending,
            )
        )
    if chat_kinds is None or chat_kinds:
        items.extend(
            item
            for item in _chat_items(
                conn,
                project_id,
                after_ts=after_ts,
                after_id=chat_after_id,
                fetch_limit=fetch_limit,
                sql_kinds=chat_kinds,
                descending=descending,
            )
            if wants(item["kind"])
        )

    items.sort(key=_sort_key)
    if cursor is not None:
        key = _cursor_key(cursor)
        if newest_first:
            items = [item for item in items if _sort_key(item) < key]
        else:
            items = [item for item in items if _sort_key(item) > key]
    has_more = len(items) > limit
    if newest_first:
        # Newest first. Rows without a timestamp are the least useful in a "recent
        # activity" list, so they only appear when the timestamped rows do not fill the
        # page; they stay in their stable ascending id order at the bottom.
        known = [item for item in items if item["timestamp"] is not None]
        unknown = [item for item in items if item["timestamp"] is None]
        page = known[-limit:][::-1] if limit else []
        if len(page) < limit:
            page = page + unknown[: limit - len(page)]
    else:
        page = items[:limit]
    next_cursor = page[-1]["cursor"] if page else None
    return {
        "items": page,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "project_id": project_id,
    }


def recent_project_activity(
    conn: sqlite3.Connection, project_id: str, *, limit: int = 10
) -> list[dict[str, Any]]:
    """The newest ``limit`` feed items, newest first (used by ``/overview``)."""
    return build_project_activity(
        conn, project_id, limit=limit, newest_first=True
    )["items"]



def project_overview(conn: sqlite3.Connection, project_id: str) -> dict[str, Any]:
    # Expire due approvals first so every count below reflects the current queue, and an
    # approval cannot look "pending" in overview while it is already dead.
    expire_pending_approvals(conn, project_id)
    counts = conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM facts WHERE project_id = ?) AS facts,
            (SELECT COUNT(*) FROM intents WHERE project_id = ?) AS intents,
            (SELECT COUNT(*) FROM intents WHERE project_id = ? AND to_fact_id IS NULL) AS open_intents,
            (SELECT COUNT(*) FROM intents WHERE project_id = ? AND to_fact_id IS NULL
                AND worker IS NOT NULL) AS working_intents,
            (SELECT COUNT(*) FROM intents WHERE project_id = ? AND to_fact_id IS NULL
                AND worker IS NULL) AS unclaimed_intents,
            (SELECT COUNT(*) FROM intents WHERE project_id = ? AND to_fact_id IS NOT NULL) AS concluded_intents,
            (SELECT COUNT(*) FROM hints WHERE project_id = ?) AS hints,
            (SELECT COUNT(*) FROM steering WHERE project_id = ? AND status = 'pending') AS pending_steering,
            (SELECT COUNT(*) FROM approval_requests WHERE project_id = ? AND status = 'pending') AS pending_approvals,
            (SELECT COUNT(*) FROM chat_conversations WHERE project_id = ?) AS chat_conversations,
            (SELECT COUNT(*) FROM chat_activities a JOIN chat_conversations c
                ON c.id = a.conversation_id WHERE c.project_id = ?) AS chat_activities,
            (SELECT COUNT(*) FROM chat_activities a JOIN chat_conversations c
                ON c.id = a.conversation_id WHERE c.project_id = ? AND a.kind = 'tool_call') AS tool_calls,
            (SELECT COALESCE(SUM(a.tokens_in), 0) FROM chat_activities a
                JOIN chat_conversations c ON c.id = a.conversation_id
                WHERE c.project_id = ? AND a.kind = 'usage') AS tokens_in,
            (SELECT COALESCE(SUM(a.tokens_out), 0) FROM chat_activities a
                JOIN chat_conversations c ON c.id = a.conversation_id
                WHERE c.project_id = ? AND a.kind = 'usage') AS tokens_out
        """,
        (project_id,) * 14,
    ).fetchone()

    workers = conn.execute(
        """
        SELECT worker AS name, id AS intent_id, last_heartbeat_at AS last_heartbeat_at
        FROM intents
        WHERE project_id = ? AND to_fact_id IS NULL AND worker IS NOT NULL
        ORDER BY created_at
        """,
        (project_id,),
    ).fetchall()
    recent = recent_project_activity(conn, project_id, limit=10)
    return {
        "project_id": project_id,
        "generated_at": utcnow(),
        "counts": {key: counts[key] for key in counts.keys()},
        "workers": [
            {
                "name": row["name"],
                "intent_id": row["intent_id"],
                "last_heartbeat_at": row["last_heartbeat_at"],
            }
            for row in workers
        ],
        "recent_activity": recent,
        "recent_activity_order": "newest_first",
    }
