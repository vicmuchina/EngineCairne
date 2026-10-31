from __future__ import annotations

"""Artex-shaped session view over Cairn chat and worker activity.

Two session sources exist:

``chat_activities``
    The main-agent conversation transcript. The newest conversation for the project is
    exposed as the single ``main`` session (1 row -> 1 activity, stable ``seq`` = row id).

``project_activity``
    Dispatcher worker runs (``run_id`` groups the transcript), the newest ``task=reason``
    run exposed as one ``plan`` session, and project/system events without a ``run_id``
    exposed as ``system``.

The builders are read-only. They never rewrite evidence and never invent rows: an absent
conversation/run yields an empty, idle session and an empty activity page.
"""

import asyncio
import json
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any

from cairn.server import activity as activity_store
from cairn.server.services import utcnow

SESSION_LIVE_WINDOW_SECONDS = 5.0
SESSION_STALE_SECONDS = 900
SYSTEM_SESSION_KINDS = ("status", "project", "import", "error")
WORKER_TRANSCRIPT_KINDS = activity_store.WORKER_CHILD_KINDS
SSE_POLL_SECONDS = 1.0
SSE_HEARTBEAT_SECONDS = 15.0
SSE_MAX_SECONDS = 600.0


def _empty_tokens() -> dict[str, Any]:
    return {"input": 0, "cache_read": 0, "output": 0, "cost": 0.0}


def _tokens_from_usage(usage: Any) -> dict[str, Any]:
    normalized = activity_store.normalize_usage(usage)
    return {
        "input": normalized["input"],
        "cache_read": normalized["cache_read"],
        "output": normalized["output"],
        "cost": normalized["cost"],
    }


def _add_tokens(total: dict[str, Any], one: dict[str, Any]) -> None:
    total["input"] = int(total.get("input", 0)) + int(one.get("input", 0))
    total["cache_read"] = int(total.get("cache_read", 0)) + int(one.get("cache_read", 0))
    total["output"] = int(total.get("output", 0)) + int(one.get("output", 0))
    total["cost"] = float(total.get("cost", 0.0)) + float(one.get("cost", 0.0))


def _epoch(value: str | None) -> float | None:
    if not value:
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _is_live(status: str, last_at: str | None, *, now: float, stale_seconds: int) -> bool:
    last = _epoch(last_at)
    if last is not None and now - last <= SESSION_LIVE_WINDOW_SECONDS:
        return True
    if status in ("running", "streaming"):
        if last is None:
            return True
        return now - last <= stale_seconds
    return False


def _clip_title(text: str | None, limit: int = 140) -> str:
    value = " ".join((text or "").split())
    if len(value) <= limit:
        return value
    return value[: limit - 1] + "…"


def _newest_conversation(conn: sqlite3.Connection, project_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM chat_conversations WHERE project_id = ? "
        "ORDER BY updated_at DESC, id DESC LIMIT 1",
        (project_id,),
    ).fetchone()


def _chat_token_totals(
    conn: sqlite3.Connection, conversation_id: int
) -> dict[str, Any]:
    row = conn.execute(
        "SELECT COALESCE(SUM(tokens_in), 0) AS tokens_in, "
        "COALESCE(SUM(tokens_out), 0) AS tokens_out "
        "FROM chat_activities WHERE conversation_id = ? AND kind = 'message' "
        "AND role = 'assistant'",
        (conversation_id,),
    ).fetchone()
    total = {
        "input": int(row["tokens_in"] or 0) if row is not None else 0,
        "cache_read": 0,
        "output": int(row["tokens_out"] or 0) if row is not None else 0,
        "cost": 0.0,
    }
    # The usage rows are additive detail; use them only when message rows carried no
    # tokens (older recordings) so input/output are never double counted.
    if total["input"] or total["output"]:
        return total
    usage_rows = conn.execute(
        "SELECT raw_json FROM chat_activities WHERE conversation_id = ? AND kind = 'usage'",
        (conversation_id,),
    ).fetchall()
    for row in usage_rows:
        try:
            raw = json.loads(row["raw_json"] or "{}")
        except (TypeError, ValueError):
            continue
        usage = raw.get("usage") if isinstance(raw, dict) else None
        if isinstance(usage, dict):
            _add_tokens(total, _tokens_from_usage(usage))
    return total


def _newest_reason_run(conn: sqlite3.Connection, project_id: str) -> str | None:
    rows = conn.execute(
        "SELECT * FROM project_activity WHERE project_id = ? AND kind = 'worker_run' "
        "AND run_id IS NOT NULL ORDER BY id DESC LIMIT 500",
        (project_id,),
    ).fetchall()
    for row in rows:
        meta = activity_store._metadata(row)
        if meta.get("task") == "reason":
            return str(row["run_id"])
    return None


def _main_session(conn: sqlite3.Connection, project_id: str, *, now: float) -> dict[str, Any]:
    conversation = _newest_conversation(conn, project_id)
    if conversation is None:
        return {
            "key": "main",
            "role": "mainagent",
            "title": "Main agent - conversation #1",
            "status": "idle",
            "live": False,
            "last_activity_at": None,
            "tokens": _empty_tokens(),
            "unread": 0,
        }
    last = conn.execute(
        "SELECT created_at FROM chat_activities WHERE conversation_id = ? "
        "ORDER BY id DESC LIMIT 1",
        (conversation["id"],),
    ).fetchone()
    last_at = last["created_at"] if last is not None else conversation["updated_at"]
    status = str(conversation["status"] or "idle")
    title = f"Main agent - {conversation['title']}" if conversation["title"] else (
        f"Main agent - conversation #{conversation['id']}"
    )
    if title == "Main agent - New conversation":
        title = f"Main agent - conversation #{conversation['id']}"
    return {
        "key": "main",
        "role": "mainagent",
        "title": title,
        "status": status,
        "live": _is_live(status, last_at, now=now, stale_seconds=SESSION_STALE_SECONDS),
        "last_activity_at": last_at,
        "tokens": _chat_token_totals(conn, conversation["id"]),
        "unread": 0,
    }


def _run_session(
    conn: sqlite3.Connection,
    project_id: str,
    run_id: str,
    *,
    role: str,
    title: str,
    now: float,
) -> dict[str, Any] | None:
    item = activity_store.build_worker_run(
        conn,
        project_id,
        run_id,
        transcript_limit=0,
        include_transcript=False,
        stale_after_seconds=SESSION_STALE_SECONDS,
    )
    if item is None:
        return None
    status = str(item["status"])
    last_at = item.get("last_event_at")
    return {
        "key": "plan" if role == "planner" else f"worker:{run_id}",
        "role": role,
        "title": title,
        "status": status,
        "live": bool(item.get("active")) or _is_live(
            status, last_at, now=now, stale_seconds=SESSION_STALE_SECONDS
        ),
        "last_activity_at": last_at,
        "tokens": _tokens_from_usage(item.get("usage")),
        "unread": 0,
        "run_id": run_id,
        "worker": item.get("worker"),
        "task": item.get("task"),
        "intent_id": item.get("intent_id"),
        "stale": bool(item.get("stale")),
        "started_at": item.get("started_at"),
        "finished_at": item.get("finished_at"),
        "duration_ms": item.get("duration_ms"),
        "model": item.get("model"),
        "counts": item.get("counts"),
    }


def _plan_session(conn: sqlite3.Connection, project_id: str, *, now: float) -> dict[str, Any]:
    run_id = _newest_reason_run(conn, project_id)
    if run_id is not None:
        session = _run_session(
            conn,
            project_id,
            run_id,
            role="planner",
            title="Planner - situation assessment",
            now=now,
        )
        if session is not None:
            return session
    return {
        "key": "plan",
        "role": "planner",
        "title": "Planner - situation assessment",
        "status": "idle",
        "live": False,
        "last_activity_at": None,
        "tokens": _empty_tokens(),
        "unread": 0,
    }


def _worker_sessions(conn: sqlite3.Connection, project_id: str, *, now: float) -> list[dict[str, Any]]:
    payload = activity_store.build_project_workers(
        conn,
        project_id,
        include_transcript=False,
        exclude_task="reason",
        limit=100,
        transcript_limit=0,
        stale_after_seconds=SESSION_STALE_SECONDS,
    )
    sessions: list[dict[str, Any]] = []
    for item in payload["items"]:
        if item.get("task") == "reason":
            # The newest reason run is the planner lane; older reason runs are history,
            # not a worker session.
            continue
        run_id = str(item["run_id"])
        description = (
            item.get("intent_description")
            or item.get("task")
            or item.get("intent_id")
            or "worker"
        )
        title = f"#{run_id[:8]} {_clip_title(str(description))}"
        status = str(item["status"])
        last_at = item.get("last_event_at")
        sessions.append(
            {
                "key": f"worker:{run_id}",
                "role": "worker",
                "title": title,
                "status": status,
                "live": bool(item.get("active"))
                or _is_live(status, last_at, now=now, stale_seconds=SESSION_STALE_SECONDS),
                "last_activity_at": last_at,
                "tokens": _tokens_from_usage(item.get("usage")),
                "unread": 0,
                "run_id": run_id,
                "worker": item.get("worker"),
                "task": item.get("task"),
                "intent_id": item.get("intent_id"),
                "stale": bool(item.get("stale")),
                "started_at": item.get("started_at"),
                "finished_at": item.get("finished_at"),
                "duration_ms": item.get("duration_ms"),
                "model": item.get("model"),
                "counts": item.get("counts"),
            }
        )
    return sessions


def _system_session(conn: sqlite3.Connection, project_id: str, *, now: float) -> dict[str, Any]:
    placeholders = ", ".join("?" for _ in SYSTEM_SESSION_KINDS)
    last = conn.execute(
        f"SELECT id, created_at FROM project_activity WHERE project_id = ? "
        f"AND run_id IS NULL AND kind IN ({placeholders}) ORDER BY id DESC LIMIT 1",
        (project_id, *SYSTEM_SESSION_KINDS),
    ).fetchone()
    last_at = last["created_at"] if last is not None else None
    return {
        "key": "system",
        "role": "system",
        "title": "System audit",
        "status": "idle",
        "live": bool(
            last_at is not None
            and (_epoch(last_at) or 0) > 0
            and now - (_epoch(last_at) or 0) <= SESSION_LIVE_WINDOW_SECONDS
        ),
        "last_activity_at": last_at,
        "tokens": _empty_tokens(),
        "unread": 0,
    }


def build_project_sessions(conn: sqlite3.Connection, project_id: str) -> dict[str, Any]:
    now = time.time()
    project = conn.execute(
        "SELECT id, status FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    project_status = str(project["status"]) if project is not None else "unknown"
    sessions = [
        _main_session(conn, project_id, now=now),
        _plan_session(conn, project_id, now=now),
        *_worker_sessions(conn, project_id, now=now),
        _system_session(conn, project_id, now=now),
    ]
    task_total = _empty_tokens()
    for session in sessions:
        _add_tokens(task_total, session["tokens"])
    return {
        "project_id": project_id,
        "generated_at": utcnow(),
        "project_status": project_status,
        "task_total": task_total,
        "sessions": sessions,
    }


# --------------------------------------------------------------- activities


def _tool_from_metadata(meta: dict[str, Any], *, description: str | None = None) -> dict[str, Any] | None:
    name = meta.get("tool_name")
    call_id = meta.get("tool_call_id")
    tool_input = meta.get("tool_input")
    tool_output = meta.get("tool_output")
    if not any((name, call_id, tool_input, tool_output)):
        return None
    duration = meta.get("duration_ms", meta.get("durationMs"))
    try:
        duration_ms = int(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration_ms = None
    return {
        "name": name,
        "call_id": call_id,
        "input": tool_input if isinstance(tool_input, str) else None,
        "output": tool_output if isinstance(tool_output, str) else None,
        "duration_ms": duration_ms,
        "is_error": bool(meta.get("is_error")),
    }


def _chat_activity(row: sqlite3.Row, project_id: str) -> dict[str, Any]:
    raw: dict[str, Any] = {}
    if row["raw_json"]:
        try:
            parsed = json.loads(row["raw_json"])
            raw = parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            raw = {}
    usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}
    tokens = {
        "input": int(row["tokens_in"] or 0),
        "output": int(row["tokens_out"] or 0),
        "cache_read": activity_store._int_number(usage.get("cacheRead")),
    }
    kind_map = {
        "thinking": "thinking",
        "tool_call": "tool_call",
        "message": "message",
        "error": "error",
    }
    kind = kind_map.get(row["kind"], "status")
    tool = _tool_from_metadata(raw, description=row["content"])
    if tool is None and row["tool_name"]:
        tool = {
            "name": row["tool_name"],
            "call_id": row["tool_call_id"],
            "input": row["tool_input"],
            "output": row["tool_output"],
            "duration_ms": None,
            "is_error": row["status"] == "error",
        }
    if tool is not None:
        if tool.get("input") is None:
            tool["input"] = row["tool_input"]
        if tool.get("output") is None:
            tool["output"] = row["tool_output"]
        if tool.get("name") is None:
            tool["name"] = row["tool_name"]
        if tool.get("call_id") is None:
            tool["call_id"] = row["tool_call_id"]
        tool["is_error"] = bool(tool.get("is_error") or row["status"] == "error")
    return {
        "seq": int(row["id"]),
        "id": int(row["id"]),
        "kind": kind,
        "role": row["role"] or "assistant",
        "status": row["status"] or "done",
        "content": None if kind in ("tool_call", "tool_result") else row["content"],
        "tool": tool,
        "tokens": tokens,
        "metadata": {
            "conversation_id": row["conversation_id"],
            "message_id": row["message_id"],
            "run_id": row["run_id"],
            "chat_kind": row["kind"],
            "error": row["error"],
            "stop_reason": raw.get("stopReason"),
        },
        "created_at": row["created_at"],
    }


def _project_activity(row: sqlite3.Row, project_id: str) -> dict[str, Any]:
    meta = activity_store._metadata(row)
    kind_map = {
        "worker_thinking": "thinking",
        "tool_call": "tool_call",
        "tool_result": "tool_result",
        "worker_message": "message",
        "worker_error": "error",
        "worker_output": "status",
        "status": "status",
        "project": "status",
        "import": "status",
        "error": "error",
    }
    kind = kind_map.get(row["kind"], "status")
    usage = meta.get("usage") if isinstance(meta.get("usage"), dict) else {}
    tokens = {
        "input": activity_store._int_number(usage.get("input")),
        "output": activity_store._int_number(usage.get("output")),
        "cache_read": activity_store._int_number(usage.get("cacheRead")),
    }
    tool = _tool_from_metadata(meta)
    if tool is not None:
        tool["is_error"] = bool(tool.get("is_error") or row["status"] == "error")
        if tool.get("input") is None and kind == "tool_call":
            tool["input"] = row["description"]
        if tool.get("output") is None and kind == "tool_result":
            tool["output"] = row["description"]
    role = "tool" if kind == "tool_result" else (
        "system"
        if kind == "error" or row["kind"] in SYSTEM_SESSION_KINDS
        else "assistant"
    )
    content = None if kind in ("tool_call", "tool_result") else row["description"]
    return {
        "seq": int(row["id"]),
        "id": int(row["id"]),
        "kind": kind,
        "role": role,
        "status": row["status"] or "done",
        "content": content,
        "tool": tool,
        "tokens": tokens,
        "metadata": meta,
        "created_at": row["created_at"],
    }


def session_key_for_activity(row: sqlite3.Row, project_id: str) -> str:
    if row["run_id"] is None:
        return "system"
    meta = activity_store._metadata(row)
    if meta.get("task") == "reason":
        return "plan"
    return f"worker:{row['run_id']}"


def _page(
    *,
    key: str,
    rows: list[sqlite3.Row],
    limit: int,
    mapper,
) -> dict[str, Any]:
    has_more = len(rows) > limit
    page_rows = rows[:limit]
    page_rows.reverse()  # SQL fetched newest-first; the contract is oldest..newest.
    items = [mapper(row) for row in page_rows]
    return {
        "key": key,
        "items": items,
        "has_more": has_more,
        "earliest_seq": items[0]["seq"] if items else None,
    }


def _activity_rows(
    conn: sqlite3.Connection,
    sql: str,
    params: list[Any],
    limit: int,
) -> list[sqlite3.Row]:
    return conn.execute(sql + " LIMIT ?", (*params, limit + 1)).fetchall()


def build_session_activities(
    conn: sqlite3.Connection,
    project_id: str,
    key: str,
    *,
    before: int | None = None,
    limit: int = 200,
) -> dict[str, Any] | None:
    limit = max(1, min(int(limit), 500))
    if key == "main":
        conversation = _newest_conversation(conn, project_id)
        if conversation is None:
            return {"key": key, "items": [], "has_more": False, "earliest_seq": None}
        rows = _activity_rows(
            conn,
            "SELECT * FROM chat_activities WHERE conversation_id = ? "
            "AND (? IS NULL OR id < ?) ORDER BY id DESC",
            [conversation["id"], before, before],
            limit,
        )
        return _page(key=key, rows=rows, limit=limit, mapper=lambda row: _chat_activity(row, project_id))
    if key == "plan":
        run_id = _newest_reason_run(conn, project_id)
        if run_id is None:
            return {"key": key, "items": [], "has_more": False, "earliest_seq": None}
        return _project_page(
            conn,
            project_id,
            key,
            run_id=run_id,
            before=before,
            limit=limit,
        )
    if key == "system":
        placeholders = ", ".join("?" for _ in SYSTEM_SESSION_KINDS)
        rows = _activity_rows(
            conn,
            "SELECT * FROM project_activity WHERE project_id = ? AND run_id IS NULL "
            f"AND kind IN ({placeholders}) AND (? IS NULL OR id < ?) ORDER BY id DESC",
            [project_id, *SYSTEM_SESSION_KINDS, before, before],
            limit,
        )
        return _page(
            key=key,
            rows=rows,
            limit=limit,
            mapper=lambda row: _project_activity(row, project_id),
        )
    if key.startswith("worker:"):
        run_id = key.split(":", 1)[1]
        if not run_id:
            return None
        exists = conn.execute(
            "SELECT 1 FROM project_activity WHERE project_id = ? AND run_id = ? LIMIT 1",
            (project_id, run_id),
        ).fetchone()
        if exists is None:
            return None
        return _project_page(
            conn,
            project_id,
            key,
            run_id=run_id,
            before=before,
            limit=limit,
        )
    return None


def _project_page(
    conn: sqlite3.Connection,
    project_id: str,
    key: str,
    *,
    run_id: str,
    before: int | None,
    limit: int,
) -> dict[str, Any]:
    placeholders = ", ".join("?" for _ in WORKER_TRANSCRIPT_KINDS)
    rows = _activity_rows(
        conn,
        "SELECT * FROM project_activity WHERE project_id = ? AND run_id = ? "
        f"AND kind IN ({placeholders}) AND (? IS NULL OR id < ?) ORDER BY id DESC",
        [project_id, run_id, *WORKER_TRANSCRIPT_KINDS, before, before],
        limit,
    )
    return _page(
        key=key,
        rows=rows,
        limit=limit,
        mapper=lambda row: _project_activity(row, project_id),
    )


# --------------------------------------------------------------------- SSE


def format_sse_activity(*, event_id: int, key: str, seq: int, activity: dict[str, Any]) -> str:
    data = json.dumps(
        {"key": key, "seq": seq, "activity": activity},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"id: {event_id}\nevent: activity\ndata: {data}\n\n"


def format_sse_heartbeat() -> str:
    return ": heartbeat\n\n"


def fetch_session_events(
    project_id: str,
    after_id: int,
    *,
    limit: int = 200,
) -> list[str]:
    """Return pre-formatted SSE frames for project_activity rows newer than ``after_id``."""
    from cairn.server.db import get_conn

    with get_conn() as conn:
        placeholders = ", ".join("?" for _ in SYSTEM_SESSION_KINDS)
        rows = conn.execute(
            "SELECT * FROM project_activity WHERE project_id = ? AND id > ? "
            "AND (run_id IS NOT NULL "
            f"OR kind IN ({placeholders})) ORDER BY id LIMIT ?",
            (
                project_id,
                int(after_id),
                *SYSTEM_SESSION_KINDS,
                max(1, min(int(limit), 1000)),
            ),
        ).fetchall()
        frames: list[str] = []
        for row in rows:
            key = session_key_for_activity(row, project_id)
            activity = _project_activity(row, project_id)
            frames.append(
                format_sse_activity(
                    event_id=int(row["id"]),
                    key=key,
                    seq=int(row["id"]),
                    activity=activity,
                )
            )
        return frames


async def stream_session_events(
    project_id: str,
    since: int = 0,
    *,
    poll_seconds: float = SSE_POLL_SECONDS,
    heartbeat_seconds: float = SSE_HEARTBEAT_SECONDS,
    max_seconds: float = SSE_MAX_SECONDS,
) -> Any:
    """Async SSE generator. DB reads run in a worker thread, never on the server loop."""
    started = time.monotonic()
    cursor = max(0, int(since))
    last_heartbeat = started
    while time.monotonic() - started < max_seconds:
        frames = await asyncio.to_thread(fetch_session_events, project_id, cursor)
        if frames:
            for frame in frames:
                cursor = int(frame.split("\n", 1)[0].removeprefix("id: "))
                yield frame
            last_heartbeat = time.monotonic()
        if time.monotonic() - last_heartbeat >= heartbeat_seconds:
            yield format_sse_heartbeat()
            last_heartbeat = time.monotonic()
        await asyncio.sleep(min(poll_seconds, max(0.01, max_seconds)))
