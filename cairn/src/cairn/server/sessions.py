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
import re
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
FENCED_BLOCK_RE = re.compile(r"```(?:json)?\s*\n?(.*?)```", re.IGNORECASE | re.DOTALL)
SSE_POLL_SECONDS = 1.0
SSE_HEARTBEAT_SECONDS = 15.0
SSE_MAX_SECONDS = 600.0
# Sessions v2: one worker session per intent (execute + conclude merged).
EXECUTE_TASK = "execute"
CONCLUDE_TASK = "conclude"
CONCLUDE_SUFFIX = "_conclude"
BOOTSTRAP_INTENT_CREATOR = "dispatcher.bootstrap"
MAX_QUEUED_SESSIONS = 25
WORKER_RUN_PAGE = 200
INTERRUPTED_STATUSES = ("cancelled", "timeout")
SUMMARY_TEXT = {
    "intents": "Proposed {count} intent{s}",
    "complete": "Goal satisfied",
    "none": "No new intents this round",
    "interrupted": "Interrupted before a plan was returned",
}


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
    runs = _reason_runs(conn, project_id)
    return runs[0] if runs else None


def _reason_runs(conn: sqlite3.Connection, project_id: str) -> list[str]:
    """Every ``task=reason`` run id, newest first (planner round history)."""
    rows = conn.execute(
        "SELECT run_id, MIN(id) AS first_id FROM project_activity "
        "WHERE project_id = ? AND run_id IS NOT NULL AND kind = 'worker_run' "
        "AND json_extract(metadata, '$.task') = 'reason' "
        "GROUP BY run_id ORDER BY first_id DESC",
        (project_id,),
    ).fetchall()
    return [str(row["run_id"]) for row in rows]


def _run_start_ids(conn: sqlite3.Connection, project_id: str) -> dict[str, int]:
    rows = conn.execute(
        "SELECT run_id, MIN(id) AS first_id FROM project_activity "
        "WHERE project_id = ? AND run_id IS NOT NULL AND kind = 'worker_run' "
        "GROUP BY run_id",
        (project_id,),
    ).fetchall()
    return {str(row["run_id"]): int(row["first_id"]) for row in rows}


def _phase_of(task: str | None) -> tuple[str, str]:
    """Split a worker task into ``(phase, base_task)``."""
    value = task or ""
    if value.endswith(CONCLUDE_SUFFIX):
        return CONCLUDE_TASK, value[: -len(CONCLUDE_SUFFIX)]
    return EXECUTE_TASK, value


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


def _last_worker_message(conn: sqlite3.Connection, project_id: str, run_id: str) -> str | None:
    row = conn.execute(
        "SELECT description FROM project_activity WHERE project_id = ? AND run_id = ? "
        "AND kind = 'worker_message' ORDER BY id DESC LIMIT 1",
        (project_id, run_id),
    ).fetchone()
    if row is None:
        return None
    return row["description"]


def _parse_planner_payload(text: str | None) -> dict[str, Any] | None:
    """Parse the planner's plan envelope from its last assistant message.

    Tolerant by contract: code fences are stripped and the last ``{...}`` block that
    decodes is used. Nested objects are considered too, so the winner is the object that
    consumes the most text at the latest offset (the outer envelope, not a nested
    ``{"from": [...]}``). Both shapes are accepted — the raw pi envelope
    (``{"accepted": true, "data": {...}}``) and the normalized ``{"kind": ...}`` form.
    """
    if not text:
        return None
    stripped = FENCED_BLOCK_RE.sub(
        lambda match: "\n" + (match.group(1) or "") + "\n", text
    )
    decoder = json.JSONDecoder()
    best: dict[str, Any] | None = None
    best_key: tuple[int, int] | None = None
    for start, char in enumerate(stripped):
        if char != "{":
            continue
        try:
            parsed, end = decoder.raw_decode(stripped[start:])
        except ValueError:
            continue
        if not isinstance(parsed, dict):
            continue
        key = (start + end, -start)
        if best_key is None or key > best_key:
            best_key = key
            best = parsed
    return best


def _classify_planner_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize a planner envelope to ``intents`` / ``complete`` / ``none``.

    Both the raw pi envelope (``{"accepted": true, "data": {...}}``) and the
    normalized ``{"kind": ...}`` form are accepted; ``data`` wins when present.
    """
    if payload is None:
        return {"kind": "none"}
    kind = payload.get("kind") if isinstance(payload.get("kind"), str) else None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else None

    def _intents(raw: list[Any]) -> dict[str, Any]:
        cleaned: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            sources = item.get("from")
            cleaned.append(
                {
                    "from": [str(value) for value in sources]
                    if isinstance(sources, list)
                    else [],
                    "description": str(item.get("description") or ""),
                }
            )
        return {"kind": "intents", "intents": cleaned, "count": len(cleaned)}

    sources = ([data] if data is not None else []) + [payload]
    for source in sources:
        intents = source.get("intents")
        if isinstance(intents, list):
            return _intents(intents)
        complete = source.get("complete")
        if isinstance(complete, str) and complete.strip():
            return {"kind": "complete", "description": complete.strip()}
        if isinstance(complete, dict):
            description = complete.get("description") or complete.get("fact") or ""
            return {"kind": "complete", "description": str(description)}
        if complete is True:
            return {"kind": "complete", "description": ""}
    if kind == "complete":
        return {"kind": "complete", "description": ""}
    return {"kind": "none"}


def _summary_text(summary: dict[str, Any]) -> str:
    kind = summary.get("kind")
    if kind == "intents":
        count = int(summary.get("count") or len(summary.get("intents") or []))
        return SUMMARY_TEXT["intents"].format(count=count, s="" if count == 1 else "s")
    if kind == "complete":
        return SUMMARY_TEXT["complete"]
    if kind == "interrupted":
        return SUMMARY_TEXT["interrupted"]
    return SUMMARY_TEXT["none"]


def _open_tool(conn: sqlite3.Connection, project_id: str, run_id: str) -> dict[str, Any] | None:
    """The tool call that was in flight when the run stopped (no paired result)."""
    rows = conn.execute(
        "SELECT * FROM project_activity WHERE project_id = ? AND run_id = ? "
        "AND kind IN ('tool_call', 'tool_result') ORDER BY id",
        (project_id, run_id),
    ).fetchall()
    open_calls: dict[str, dict[str, Any]] = {}
    for row in rows:
        meta = activity_store._metadata(row)
        call_id = str(meta.get("tool_call_id") or f"row:{row['id']}")
        if row["kind"] == "tool_call":
            open_calls[call_id] = {
                "name": meta.get("tool_name"),
                "call_id": call_id,
                "input": meta.get("tool_input") or row["description"],
            }
        else:
            open_calls.pop(call_id, None)
    if not open_calls:
        return None
    return list(open_calls.values())[-1]


def _format_duration(duration_ms: int | None) -> str:
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


def _interruption_report(
    conn: sqlite3.Connection,
    project_id: str,
    run_id: str,
    item: dict[str, Any],
    *,
    project_status: str,
) -> dict[str, Any]:
    """Structured interruption report for a cancelled/timed-out run (no new rows)."""
    status = str(item.get("status") or "cancelled")
    if project_status == "stopped":
        reason = "paused_by_user"
    elif status == "timeout":
        reason = "timeout"
    else:
        reason = "cancelled"
    usage = activity_store.normalize_usage(item.get("usage"))
    turns = int((item.get("counts") or {}).get("messages") or 0)
    duration_ms = item.get("duration_ms")
    tool = _open_tool(conn, project_id, run_id)
    tool_text = (
        "none (no tool call was in flight)"
        if tool is None
        else f"{tool.get('name') or 'unknown'} {tool.get('input') or ''} (returned no result)"
    )
    text = (
        f"The run was interrupted: {reason}. Terminal state: {status}.\n"
        f"Executed: {turns} model turns. This run took: {_format_duration(duration_ms)}.\n"
        f"Cumulative tokens: input {usage['input']} / output {usage['output']} "
        f"/ cache read {usage['cache_read']}.\n"
        f"Tool running at interruption: {tool_text}."
    )
    return {
        "reason": reason,
        "terminal_state": status,
        "turns": turns,
        "duration_ms": duration_ms,
        "usage": {
            "input": usage["input"],
            "output": usage["output"],
            "cache_read": usage["cache_read"],
        },
        "tool": tool,
        "text": text,
        "run_id": run_id,
    }


def _plan_summary(
    conn: sqlite3.Connection,
    project_id: str,
    run_id: str,
    item: dict[str, Any],
    *,
    project_status: str,
) -> dict[str, Any]:
    text = _last_worker_message(conn, project_id, run_id)
    summary = _classify_planner_payload(_parse_planner_payload(text))
    parsed = summary.get("kind") != "none"
    if not parsed and str(item.get("status")) in INTERRUPTED_STATUSES:
        summary = {
            "kind": "interrupted",
            "interruption": _interruption_report(
                conn, project_id, run_id, item, project_status=project_status
            ),
        }
    return summary


def _plan_session(
    conn: sqlite3.Connection, project_id: str, *, now: float, project_status: str = "active"
) -> dict[str, Any]:
    runs = _reason_runs(conn, project_id)
    run_id = runs[0] if runs else None
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
            session["round"] = len(runs)
            summary = _plan_summary(
                conn, project_id, run_id, session, project_status=project_status
            )
            session["summary"] = summary
            session["summary_text"] = _summary_text(summary)
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
        "round": 0,
        "summary": None,
        "summary_text": None,
    }


def _phase_sort_key(item: dict[str, Any], start_ids: dict[str, int]) -> int:
    return start_ids.get(str(item.get("run_id")), 0)


def _earliest(values: list[str | None]) -> str | None:
    present = [value for value in values if value]
    if not present:
        return None
    return min(present, key=lambda value: (_epoch(value) or 0.0))


def _latest(values: list[str | None]) -> str | None:
    present = [value for value in values if value]
    if not present:
        return None
    return max(present, key=lambda value: (_epoch(value) or 0.0))


def _sum_usage(items: list[dict[str, Any]]) -> dict[str, Any]:
    total = activity_store.normalize_usage(None)
    for item in items:
        activity_store.add_usage(total, item.get("usage"))
    return total


def _sum_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    total = {
        "activities": 0,
        "thinking": 0,
        "tool_calls": 0,
        "tool_results": 0,
        "messages": 0,
        "errors": 0,
    }
    for item in items:
        counts = item.get("counts") or {}
        for key in total:
            total[key] += int(counts.get(key) or 0)
    return total


def _merge_run_groups(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group non-planner runs by intent (fallback run id), newest run first.

    One group is one worker session: the newest execute run plus the newest
    ``*_conclude`` run of the same intent. Older retries stay in ``runs`` for provenance
    but do not create a second session.
    """
    groups: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for item in items:
        task = str(item.get("task") or "")
        phase, base = _phase_of(task)
        if base == "reason":
            continue
        run_id = str(item["run_id"])
        key = str(item.get("intent_id") or f"run:{run_id}")
        group = groups.get(key)
        if group is None:
            group = {
                "key": key,
                "intent_id": item.get("intent_id"),
                "intent_description": item.get("intent_description"),
                "base_task": base,
                "worker": item.get("worker"),
                "execute": None,
                "conclude": None,
                "runs": [],
            }
            groups[key] = group
            order.append(key)
        group["runs"].append(item)
        if group[phase] is None:
            group[phase] = item
    return [groups[key] for key in order]


def _merge_worker_session(
    group: dict[str, Any],
    *,
    start_ids: dict[str, int],
    project_status: str,
    now: float,
) -> dict[str, Any]:
    execute = group["execute"]
    conclude = group["conclude"]
    phases = [item for item in (execute, conclude) if item is not None]
    key_run = execute or conclude
    run_id = str(key_run["run_id"])
    execute_status = str(execute["status"]) if execute is not None else None
    conclude_status = str(conclude["status"]) if conclude is not None else None
    open_phase = any(
        str(item["status"]) in activity_store.WORKER_OPEN_STATUSES for item in phases
    )
    if conclude_status == "success":
        status = "success"
    elif conclude is None and execute_status == "success":
        status = "success"
    elif open_phase:
        status = "running"
    else:
        status = execute_status or conclude_status or "unknown"

    started_at = _earliest([item.get("started_at") for item in phases])
    finished_at = _latest([item.get("finished_at") for item in phases])
    durations = [
        item.get("duration_ms")
        for item in phases
        if isinstance(item.get("duration_ms"), int)
    ]
    if durations:
        duration_ms = int(sum(durations))
    else:
        start_epoch = _epoch(started_at)
        end_epoch = _epoch(finished_at)
        duration_ms = (
            max(0, int((end_epoch - start_epoch) * 1000))
            if start_epoch is not None and end_epoch is not None
            else None
        )

    usage = _sum_usage(phases)
    newest_phase = max(phases, key=lambda item: _phase_sort_key(item, start_ids))
    description = (
        (execute or {}).get("intent_description")
        or (conclude or {}).get("intent_description")
        or group.get("intent_description")
        or group.get("base_task")
        or group.get("intent_id")
        or "worker"
    )
    last_activity_at = _latest([item.get("last_event_at") for item in phases])
    live = any(bool(item.get("active")) for item in phases) or _is_live(
        status, last_activity_at, now=now, stale_seconds=SESSION_STALE_SECONDS
    )
    interrupted = status in INTERRUPTED_STATUSES and conclude_status != "success"
    if interrupted:
        if project_status == "stopped":
            interrupt_reason = "paused_by_user"
        elif any(str(item["status"]) == "timeout" for item in phases):
            interrupt_reason = "timeout"
        else:
            interrupt_reason = "cancelled"
    else:
        interrupt_reason = None
    runs = [
        {
            "run_id": str(item["run_id"]),
            "task": item.get("task"),
            "status": str(item["status"]),
            "started_at": item.get("started_at"),
            "finished_at": item.get("finished_at"),
            "duration_ms": item.get("duration_ms"),
            "usage": activity_store.normalize_usage(item.get("usage")),
            "model": item.get("model"),
        }
        for item in sorted(
            group["runs"], key=lambda entry: _phase_sort_key(entry, start_ids)
        )
    ]
    return {
        "key": f"worker:{run_id}",
        "role": "worker",
        "title": f"#{run_id[:8]} {_clip_title(str(description))}",
        "status": status,
        "live": live,
        "last_activity_at": last_activity_at,
        "tokens": _tokens_from_usage(usage),
        "usage": usage,
        "unread": 0,
        "run_id": run_id,
        "worker": newest_phase.get("worker") or key_run.get("worker"),
        "task": group.get("base_task"),
        "intent_id": group.get("intent_id"),
        "intent_description": (execute or conclude or {}).get("intent_description"),
        "stale": all(bool(item.get("stale")) for item in phases),
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "model": newest_phase.get("model"),
        "counts": _sum_counts(phases),
        "runs": runs,
        "phases": {"execute": execute_status, "conclude": conclude_status},
        "interrupted": interrupted,
        "interrupt_reason": interrupt_reason,
        "queued": False,
    }


def _queued_sessions(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    project_status: str,
    claimed_intents: set[str],
) -> list[dict[str, Any]]:
    """Open, unclaimed intents waiting for a dispatch slot (Artex's queued rail)."""
    if project_status == "completed":
        return []
    rows = conn.execute(
        "SELECT id, description, creator FROM intents WHERE project_id = ? "
        "AND concluded_at IS NULL AND (worker IS NULL OR worker = '') "
        "ORDER BY created_at, rowid",
        (project_id,),
    ).fetchall()
    sessions: list[dict[str, Any]] = []
    for row in rows:
        intent_id = str(row["id"])
        if intent_id in claimed_intents or row["creator"] == BOOTSTRAP_INTENT_CREATOR:
            continue
        sessions.append(
            {
                "key": f"queued:{intent_id}",
                "role": "worker",
                "title": f"#queued {_clip_title(str(row['description'] or intent_id))}",
                "status": "queued",
                "live": False,
                "queued": True,
                "last_activity_at": None,
                "tokens": _empty_tokens(),
                "unread": 0,
                "run_id": None,
                "worker": None,
                "task": None,
                "intent_id": intent_id,
                "intent_description": row["description"],
                "started_at": None,
                "finished_at": None,
                "duration_ms": None,
                "model": None,
                "counts": _sum_counts([]),
                "runs": [],
                "phases": {"execute": None, "conclude": None},
                "interrupted": False,
                "interrupt_reason": None,
            }
        )
        if len(sessions) >= MAX_QUEUED_SESSIONS:
            break
    return sessions


def _worker_sessions(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    now: float,
    project_status: str = "active",
) -> list[dict[str, Any]]:
    payload = activity_store.build_project_workers(
        conn,
        project_id,
        include_transcript=False,
        exclude_task="reason",
        limit=WORKER_RUN_PAGE,
        transcript_limit=0,
        stale_after_seconds=SESSION_STALE_SECONDS,
    )
    start_ids = _run_start_ids(conn, project_id)
    groups = _merge_run_groups(payload["items"])
    sessions = [
        _merge_worker_session(
            group,
            start_ids=start_ids,
            project_status=project_status,
            now=now,
        )
        for group in groups
    ]
    claimed = {
        str(session["intent_id"]) for session in sessions if session.get("intent_id")
    }
    queued = _queued_sessions(
        conn,
        project_id,
        project_status=project_status,
        claimed_intents=claimed,
    )
    live: list[dict[str, Any]] = []
    finished: list[dict[str, Any]] = []
    for session in sessions:
        if session["live"] or session["status"] == "running":
            live.append(session)
        else:
            finished.append(session)
    return live + queued + finished


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
        _plan_session(conn, project_id, now=now, project_status=project_status),
        *_worker_sessions(conn, project_id, now=now, project_status=project_status),
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
        "worker_interruption": "interruption",
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


def session_key_for_activity(
    row: sqlite3.Row,
    project_id: str,
    *,
    conn: sqlite3.Connection | None = None,
) -> str:
    """Session key for one live ``project_activity`` row (SSE fan-out).

    A conclude phase's rows belong to the merged worker session keyed by the execute run,
    so the SSE stream addresses the same key as ``GET /sessions``. Without a connection
    (legacy callers) the run's own id is used.
    """
    if row["run_id"] is None:
        return "system"
    meta = activity_store._metadata(row)
    if meta.get("task") == "reason":
        return "plan"
    run_id = str(row["run_id"])
    if conn is not None:
        phase, base = _phase_of(meta.get("task"))
        if phase == CONCLUDE_TASK and base != "reason":
            merged = _merged_run_ids(conn, project_id, run_id)
            if merged:
                return f"worker:{merged[0]}"
    return f"worker:{run_id}"


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
            run_ids=[run_id],
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
    if key.startswith("queued:"):
        intent_id = key.split(":", 1)[1]
        if not intent_id:
            return None
        exists = conn.execute(
            "SELECT 1 FROM intents WHERE project_id = ? AND id = ? LIMIT 1",
            (project_id, intent_id),
        ).fetchone()
        if exists is None:
            return None
        # No transcript yet: the intent is waiting for a dispatch slot.
        return {"key": key, "items": [], "has_more": False, "earliest_seq": 0}
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
        run_ids = _merged_run_ids(conn, project_id, run_id)
        # The page is keyed by the merged session (the execute phase's run id), so a
        # client polling either phase's run id converges on the same session.
        canonical = f"worker:{run_ids[0]}"
        return _project_page(
            conn,
            project_id,
            canonical,
            run_ids=run_ids,
            before=before,
            limit=limit,
        )
    return None


def _merged_run_ids(
    conn: sqlite3.Connection, project_id: str, run_id: str
) -> list[str]:
    """Every run id that belongs to the same worker session as ``run_id``.

    Accepts either phase's run id (execute or ``*_conclude``) and returns the merged
    transcript's runs — the newest execute plus the newest conclude — in start order.
    """
    row = conn.execute(
        "SELECT * FROM project_activity WHERE project_id = ? AND run_id = ? "
        "AND kind = 'worker_run' ORDER BY id LIMIT 1",
        (project_id, run_id),
    ).fetchone()
    if row is None:
        return [run_id]
    meta = activity_store._metadata(row)
    intent_id = meta.get("intent_id")
    phase, base = _phase_of(meta.get("task"))
    if not intent_id or base == "reason":
        return [run_id]
    rows = conn.execute(
        "SELECT run_id, MIN(id) AS first_id, json_extract(metadata, '$.task') AS task "
        "FROM project_activity WHERE project_id = ? AND run_id IS NOT NULL "
        "AND kind = 'worker_run' AND json_extract(metadata, '$.intent_id') = ? "
        "GROUP BY run_id ORDER BY first_id DESC",
        (project_id, intent_id),
    ).fetchall()
    execute_id: str | None = None
    conclude_id: str | None = None
    for candidate in rows:
        candidate_phase, candidate_base = _phase_of(candidate["task"])
        if candidate_base == "reason":
            continue
        if candidate_phase == EXECUTE_TASK and execute_id is None:
            execute_id = str(candidate["run_id"])
        elif candidate_phase == CONCLUDE_TASK and conclude_id is None:
            conclude_id = str(candidate["run_id"])
    ordered = [
        entry for entry in (execute_id, conclude_id) if entry is not None
    ]
    if not ordered:
        return [run_id]
    first_ids = {str(candidate["run_id"]): int(candidate["first_id"]) for candidate in rows}
    return sorted(dict.fromkeys(ordered), key=lambda entry: first_ids.get(entry, 0))


def _project_page(
    conn: sqlite3.Connection,
    project_id: str,
    key: str,
    *,
    run_ids: list[str],
    before: int | None,
    limit: int,
) -> dict[str, Any]:
    placeholders = ", ".join("?" for _ in WORKER_TRANSCRIPT_KINDS)
    run_placeholders = ", ".join("?" for _ in run_ids)
    rows = _activity_rows(
        conn,
        "SELECT * FROM project_activity WHERE project_id = ? "
        f"AND run_id IN ({run_placeholders}) "
        f"AND kind IN ({placeholders}) AND (? IS NULL OR id < ?) ORDER BY id DESC",
        [project_id, *run_ids, *WORKER_TRANSCRIPT_KINDS, before, before],
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
            key = session_key_for_activity(row, project_id, conn=conn)
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
