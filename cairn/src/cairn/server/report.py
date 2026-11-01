from __future__ import annotations

"""Deterministic project report (Markdown) assembled from the fact graph.

No LLM, no network, no writes: every line is derived from the rows that already exist
(projects, facts, intents, hints, intent_sources, project_activity). The report is the
task-agnostic "what happened / how do I verify it" document for one project.
"""

import sqlite3
from typing import Any

from cairn.server import activity as activity_store
from cairn.server.services import utcnow

MAX_DESCRIPTION = 8_192
MAX_CELL = 180
MAX_REPORT_BYTES = 200_000
SUMMARY_DESCRIPTION = 500


def _clip(value: str | None, limit: int) -> str:
    text = value or ""
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _cell(value: Any, limit: int = MAX_CELL) -> str:
    text = _clip(" ".join(str(value or "").split()), limit)
    return text.replace("|", "\\|")


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


def _format_tokens(usage: dict[str, Any]) -> str:
    normalized = activity_store.normalize_usage(usage)
    total = normalized["input"] + normalized["cache_read"] + normalized["output"]
    return f"{total:,} tokens"


def _epoch(value: str | None) -> float | None:
    from cairn.server.sessions import _epoch as session_epoch

    return session_epoch(value)


def _first_line(text: str | None, limit: int = 110) -> str:
    value = " ".join((text or "").split())
    for separator in (". ", " — ", " - "):
        index = value.find(separator)
        if 0 < index < limit:
            value = value[:index]
            break
    return _clip(value, limit)


def _load_facts(conn: sqlite3.Connection, project_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, description FROM facts WHERE project_id = ? ORDER BY rowid",
        (project_id,),
    ).fetchall()


def _load_intents(conn: sqlite3.Connection, project_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM intents WHERE project_id = ? ORDER BY created_at, rowid",
        (project_id,),
    ).fetchall()


def _load_sources(conn: sqlite3.Connection, project_id: str) -> dict[str, list[str]]:
    rows = conn.execute(
        "SELECT intent_id, fact_id FROM intent_sources WHERE project_id = ? ORDER BY rowid",
        (project_id,),
    ).fetchall()
    sources: dict[str, list[str]] = {}
    for row in rows:
        sources.setdefault(str(row["intent_id"]), []).append(str(row["fact_id"]))
    return sources


def _load_runs(conn: sqlite3.Connection, project_id: str) -> list[dict[str, Any]]:
    """Per-run aggregates (status, usage, counts, timestamps) from existing rows."""
    counts = {
        str(row["run_id"]): row
        for row in conn.execute(
            """
            SELECT run_id,
                   MIN(id) AS first_id,
                   SUM(CASE WHEN kind = 'tool_call' THEN 1 ELSE 0 END) AS tool_calls,
                   SUM(CASE WHEN kind = 'worker_message' THEN 1 ELSE 0 END) AS messages,
                   SUM(CASE WHEN kind = 'worker_thinking' THEN 1 ELSE 0 END) AS thinking,
                   SUM(CASE WHEN kind = 'worker_error' THEN 1 ELSE 0 END) AS errors
            FROM project_activity
            WHERE project_id = ? AND run_id IS NOT NULL
            GROUP BY run_id
            """,
            (project_id,),
        ).fetchall()
    }
    rows = conn.execute(
        "SELECT * FROM project_activity WHERE project_id = ? AND run_id IS NOT NULL "
        "AND kind = 'worker_run' ORDER BY id",
        (project_id,),
    ).fetchall()
    runs: dict[str, dict[str, Any]] = {}
    for row in rows:
        run_id = str(row["run_id"])
        meta = activity_store._metadata(row)
        entry = runs.get(run_id)
        if entry is None:
            entry = {
                "run_id": run_id,
                "task": meta.get("task"),
                "intent_id": meta.get("intent_id"),
                "worker": row["actor"] or meta.get("worker"),
                "status": row["status"],
                "started_at": meta.get("started_at"),
                "finished_at": None,
                "duration_ms": None,
                "usage": activity_store.normalize_usage(None),
                "model": None,
                "first_id": int((counts.get(run_id) or {"first_id": row["id"]})["first_id"]),
            }
            runs[run_id] = entry
        if entry.get("task") is None:
            entry["task"] = meta.get("task")
        if entry.get("intent_id") is None:
            entry["intent_id"] = meta.get("intent_id")
        entry["status"] = row["status"] or entry["status"]
        if meta.get("started_at"):
            entry["started_at"] = meta.get("started_at")
        if meta.get("finished_at"):
            entry["finished_at"] = meta.get("finished_at")
        if isinstance(meta.get("duration_ms"), int):
            entry["duration_ms"] = meta.get("duration_ms")
        if isinstance(meta.get("usage"), dict):
            entry["usage"] = activity_store.normalize_usage(meta["usage"])
        if meta.get("model"):
            entry["model"] = meta.get("model")
        row_counts = counts.get(run_id)
        if row_counts is not None:
            entry["first_id"] = int(row_counts["first_id"])
            entry["tool_calls"] = int(row_counts["tool_calls"] or 0)
            entry["messages"] = int(row_counts["messages"] or 0)
            entry["thinking"] = int(row_counts["thinking"] or 0)
            entry["errors"] = int(row_counts["errors"] or 0)
    result = list(runs.values())
    for entry in result:
        entry.setdefault("tool_calls", 0)
        entry.setdefault("messages", 0)
        entry.setdefault("thinking", 0)
        entry.setdefault("errors", 0)
    result.sort(key=lambda entry: entry["first_id"])
    return result


def _phase_of(task: str | None) -> tuple[str, str]:
    value = task or ""
    if value.endswith("_conclude"):
        return "conclude", value[: -len("_conclude")]
    return "execute", value


def _session_key(run_id: str) -> str:
    return f"worker:{run_id[:8]}"


def build_project_report(conn: sqlite3.Connection, project_id: str) -> dict[str, Any]:
    project = conn.execute(
        "SELECT id, title, status, created_at FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    if project is None:
        raise LookupError(project_id)
    from cairn.server import domain as domain_store

    facts = _load_facts(conn, project_id)
    entities = domain_store.list_entities(conn, project_id, limit=2000)
    findings = domain_store.list_findings(conn, project_id, limit=1000)
    retests = domain_store.list_retests(conn, project_id, limit=1000)
    coverage = domain_store.compute_coverage(conn, project_id, untested_limit=40)
    hints = conn.execute(
        "SELECT content, creator, created_at FROM hints WHERE project_id = ? "
        "ORDER BY created_at, rowid",
        (project_id,),
    ).fetchall()
    intents = _load_intents(conn, project_id)
    sources = _load_sources(conn, project_id)
    runs = _load_runs(conn, project_id)

    facts_by_id = {str(row["id"]): row for row in facts}
    origin = _clip((facts_by_id.get("origin") or {"description": ""})["description"], MAX_DESCRIPTION)
    goal = _clip((facts_by_id.get("goal") or {"description": ""})["description"], MAX_DESCRIPTION)
    produced = [row for row in facts if str(row["id"]) not in ("origin", "goal")]

    runs_by_intent: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        intent_id = run.get("intent_id")
        if intent_id:
            runs_by_intent.setdefault(str(intent_id), []).append(run)
    producing_intent: dict[str, sqlite3.Row] = {}
    for intent in intents:
        target = intent["to_fact_id"]
        if target:
            producing_intent[str(target)] = intent

    total_usage = activity_store.normalize_usage(None)
    for run in runs:
        activity_store.add_usage(total_usage, run.get("usage"))
    tool_calls = sum(int(run.get("tool_calls") or 0) for run in runs)
    messages = sum(int(run.get("messages") or 0) for run in runs)
    open_intents = [row for row in intents if row["concluded_at"] is None]
    completed_intents = [row for row in intents if row["concluded_at"] is not None]

    started = [run["started_at"] for run in runs if run.get("started_at")]
    finished = [run["finished_at"] for run in runs if run.get("finished_at")]
    span_ms: int | None = None
    first_ts = min(started, key=lambda value: _epoch(value) or 0.0) if started else project["created_at"]
    last_ts = max(finished, key=lambda value: _epoch(value) or 0.0) if finished else None
    if first_ts and last_ts:
        start_epoch, end_epoch = _epoch(first_ts), _epoch(last_ts)
        if start_epoch is not None and end_epoch is not None:
            span_ms = max(0, int((end_epoch - start_epoch) * 1000))

    counts = {
        "facts": len(facts),
        "findings": len(produced),
        "open_intents": len(open_intents),
        "completed_intents": len(completed_intents),
        "work_runs": len(runs),
        "tool_calls": tool_calls,
        "messages": messages,
        "tokens": {
            "input": total_usage["input"],
            "cache_read": total_usage["cache_read"],
            "output": total_usage["output"],
        },
        "wall_clock_ms": span_ms,
        "hints": len(hints),
    }

    lines: list[str] = []
    lines.append(f"# {_clip(' '.join(project['title'].split()), MAX_CELL)}")
    lines.append("")
    lines.append(
        f"Generated: {utcnow()} · Status: {project['status']} · Project: {project['id']}"
    )
    lines.append("")
    lines.append("## Engagement summary")
    lines.append("")
    lines.append(origin or "_No origin fact recorded._")
    lines.append("")
    lines.append("## Goal")
    lines.append("")
    lines.append(goal or "_No goal fact recorded._")
    lines.append("")
    lines.append("## Operator constraints")
    lines.append("")
    if hints:
        for hint in hints:
            lines.append(f"- {_clip(' '.join(hint['content'].split()), 1_000)} ({hint['creator']})")
    else:
        lines.append("- None recorded.")
    lines.append("")

    lines.append("## Results at a glance")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Facts | {counts['facts']} |")
    lines.append(f"| Confirmed facts | {counts['findings']} |")
    if findings:
        lines.append(f"| Recorded findings | {len(findings)} |")
    if entities:
        lines.append(f"| Entities | {len(entities)} |")
    lines.append(f"| Open intents | {counts['open_intents']} |")
    lines.append(f"| Completed intents | {counts['completed_intents']} |")
    lines.append(f"| Work runs | {counts['work_runs']} |")
    lines.append(f"| Tool calls | {counts['tool_calls']} |")
    lines.append(
        "| Total tokens (input / cache read / output) | "
        f"{total_usage['input']:,} / {total_usage['cache_read']:,} / {total_usage['output']:,} |"
    )
    lines.append(
        f"| Wall-clock span | {_format_duration(span_ms)}"
        f" ({_cell(first_ts, 40)} → {_cell(last_ts, 40)}) |"
    )
    lines.append("")

    lines.append("## Confirmed facts")
    lines.append("")
    if not produced:
        lines.append("_No findings recorded yet._")
        lines.append("")
    for index, fact in enumerate(produced, start=1):
        fact_id = str(fact["id"])
        intent = producing_intent.get(fact_id)
        run = None
        if intent is not None:
            intent_runs = runs_by_intent.get(str(intent["id"]), [])
            run = next(
                (
                    entry
                    for entry in intent_runs
                    if _phase_of(entry.get("task"))[0] == "execute"
                ),
                intent_runs[0] if intent_runs else None,
            )
        lines.append(f"### F{index}. {_first_line(fact['description'])}")
        lines.append("")
        if intent is not None:
            intent_runs = runs_by_intent.get(str(intent["id"]), [])
            usage = activity_store.normalize_usage(None)
            for entry in intent_runs:
                activity_store.add_usage(usage, entry.get("usage"))
            duration = sum(
                int(entry.get("duration_ms") or 0) for entry in intent_runs
            ) or None
            lines.append(
                f"- Fact: {fact_id} · produced by intent {intent['id']} "
                f"({intent['worker'] or intent['creator']}, {_format_duration(duration)}, "
                f"{_format_tokens(usage)})"
            )
            if run is not None:
                lines.append(
                    f"- Evidence: {int(run.get('tool_calls') or 0)} tool calls, "
                    f"run {str(run['run_id'])[:8]}; transcript "
                    f"`GET /projects/{project_id}/sessions/{_session_key(run['run_id'])}/activities`"
                )
        else:
            lines.append(f"- Fact: {fact_id} · not produced by a recorded intent")
        lines.append("")
        lines.append(_clip(fact["description"], MAX_DESCRIPTION))
        lines.append("")

    if coverage["denominator"] or entities:
        lines.append("## Scope and coverage")
        lines.append("")
        pct = f"{coverage['pct'] * 100:.1f}%" if coverage["pct"] is not None else "—"
        lines.append(
            f"**{coverage['tested']} / {coverage['denominator']} tested ({pct})** · "
            f"{len(entities)} entities · {coverage['scope_rows']} in scope"
        )
        lines.append("")
        if coverage["by_kind"]:
            lines.append("| kind | tested | total |")
            lines.append("| --- | --- | --- |")
            for item in coverage["by_kind"]:
                lines.append(f"| {_cell(item['kind'], 60)} | {item['tested']} | {item['total']} |")
            lines.append("")
        if coverage["untested"]:
            lines.append("Untested in-scope entities (sample):")
            lines.append("")
            for item in coverage["untested"]:
                lines.append(
                    f"- [{_cell(item['kind'], 40)}] {_cell(item['label'] or item['key'], 160)} "
                    f"({item['id']})"
                )
            lines.append("")

    if findings:
        lines.append("## Findings")
        lines.append("")
        lines.append("| id | severity | status | class | title |")
        lines.append("| --- | --- | --- | --- | --- |")
        for finding in findings:
            lines.append(
                "| "
                + " | ".join(
                    [
                        _cell(finding["id"], 40),
                        _cell(finding["severity"] or "-", 20),
                        _cell(finding["status"], 40),
                        _cell(finding["klass"] or "-", 80),
                        _cell(finding["title"], 160),
                    ]
                )
                + " |"
            )
        lines.append("")
        for finding in findings:
            lines.append(f"### {finding['id']} — {_clip(finding['title'], 200)}")
            lines.append("")
            meta = [
                f"severity={finding['severity'] or 'unset'}",
                f"status={finding['status']}",
                f"class={finding['klass'] or 'unset'}",
            ]
            if finding["fact_id"]:
                meta.append(f"fact={finding['fact_id']}")
            if finding["entity_ids"]:
                meta.append("entities=" + ", ".join(finding["entity_ids"][:8]))
            lines.append("- " + " · ".join(meta))
            if finding["summary"]:
                lines.append("")
                lines.append(_clip(finding["summary"], MAX_DESCRIPTION))
            if finding["evidence"]:
                lines.append("")
                lines.append("Evidence:")
                lines.append("```")
                lines.append(_clip(finding["evidence"], MAX_DESCRIPTION))
                lines.append("```")
            lines.append("")

    if retests:
        lines.append("## Retests")
        lines.append("")
        lines.append("| retest | finding | status | verdict | started | finished |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for retest in retests:
            lines.append(
                "| "
                + " | ".join(
                    [
                        _cell(retest["id"], 40),
                        _cell(retest["finding_id"], 40),
                        _cell(retest["status"], 40),
                        _cell(retest["verdict"] or "-", 40),
                        _cell(retest["started_at"] or "-", 40),
                        _cell(retest["finished_at"] or "-", 40),
                    ]
                )
                + " |"
            )
        lines.append("")
        for retest in retests:
            if retest["summary"] or retest["evidence"]:
                lines.append(f"### {retest['id']} — {retest['verdict'] or retest['status']}")
                lines.append("")
                if retest["summary"]:
                    lines.append(_clip(retest["summary"], MAX_DESCRIPTION))
                    lines.append("")
                if retest["evidence"]:
                    lines.append("```")
                    lines.append(_clip(retest["evidence"], MAX_DESCRIPTION))
                    lines.append("```")
                    lines.append("")

    lines.append("## Intent ledger")
    lines.append("")
    lines.append("| intent | status | from | outcome | duration | tokens |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for intent in intents:
        intent_id = str(intent["id"])
        if intent["to_fact_id"]:
            status = "concluded"
        elif intent["worker"]:
            status = "working"
        else:
            status = "open"
        from_ids = sources.get(intent_id, [])
        intent_runs = runs_by_intent.get(intent_id, [])
        duration = sum(int(entry.get("duration_ms") or 0) for entry in intent_runs) or None
        usage = activity_store.normalize_usage(None)
        for entry in intent_runs:
            activity_store.add_usage(usage, entry.get("usage"))
        lines.append(
            "| "
            + " | ".join(
                [
                    _cell(intent_id, 40),
                    status,
                    _cell(", ".join(from_ids) or "-", 80),
                    _cell(intent["to_fact_id"] or "-", 40),
                    _format_duration(duration),
                    _format_tokens(usage),
                ]
            )
            + " |"
        )
    lines.append("")

    lines.append("## Verification & reproducibility")
    lines.append("")
    if runs:
        lines.append("| run | task | status | tools | messages | started | finished | tokens |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for run in runs:
            usage = activity_store.normalize_usage(run.get("usage"))
            lines.append(
                "| "
                + " | ".join(
                    [
                        _cell(str(run["run_id"])[:8], 20),
                        _cell(run.get("task") or "-", 40),
                        _cell(run.get("status") or "-", 20),
                        str(int(run.get("tool_calls") or 0)),
                        str(int(run.get("messages") or 0)),
                        _cell(run.get("started_at") or "-", 30),
                        _cell(run.get("finished_at") or "-", 30),
                        f"{usage['input']:,}/{usage['cache_read']:,}/{usage['output']:,}",
                    ]
                )
                + " |"
            )
    else:
        lines.append("_No work runs recorded._")
    lines.append("")
    if runs:
        lines.append("Phases and transcripts:")
        lines.append("")
        for run in runs:
            phase, base = _phase_of(run.get("task"))
            lines.append(
                f"- `{_session_key(run['run_id'])}` {base or 'worker'} {phase} "
                f"{run.get('status')} · {int(run.get('tool_calls') or 0)} tool calls · "
                f"{int(run.get('messages') or 0)} messages · "
                f"{_cell(run.get('started_at') or '-', 30)} → {_cell(run.get('finished_at') or '-', 30)}"
            )
        lines.append("")
    lines.append("Replay with the existing API (read-only, no dispatcher needed):")
    lines.append("")
    lines.append(f"- `curl -s http://127.0.0.1:8000/projects/{project_id}`")
    lines.append(f"- `curl -s http://127.0.0.1:8000/projects/{project_id}/sessions`")
    lines.append(
        f"- `curl -s http://127.0.0.1:8000/projects/{project_id}/export?format=timeline`"
    )
    for run in runs:
        phase, base = _phase_of(run.get("task"))
        if phase != "execute" or base == "reason":
            continue
        lines.append(
            f"- `curl -s http://127.0.0.1:8000/projects/{project_id}/sessions/"
            f"{_session_key(run['run_id'])}/activities`"
        )
    lines.append("")

    lines.append("## Retest plan")
    lines.append("")
    if produced:
        for fact in produced:
            fact_id = str(fact["id"])
            intent = producing_intent.get(fact_id)
            if intent is not None:
                lines.append(
                    f"- [ ] Re-run intent {intent['id']} "
                    f"({_first_line(intent['description'], 90)}) and compare outcome "
                    f"fact {fact_id}"
                )
            else:
                lines.append(
                    f"- [ ] Re-verify fact {fact_id} ({_first_line(fact['description'], 90)})"
                )
    else:
        lines.append("- [ ] No findings yet: run the next planner round.")
    lines.append("")

    lines.append("## Appendix: all facts")
    lines.append("")
    for fact in facts:
        lines.append(f"### {fact['id']}")
        lines.append("")
        lines.append(_clip(fact["description"], MAX_DESCRIPTION))
        lines.append("")

    markdown = "\n".join(lines).strip() + "\n"
    encoded = markdown.encode("utf-8")
    if len(encoded) > MAX_REPORT_BYTES:
        # Byte cap (not char cap): a description can be multi-byte UTF-8.
        markdown = (
            encoded[:MAX_REPORT_BYTES].decode("utf-8", "ignore")
            + "\n…[report truncated]\n"
        )
    return {
        "project_id": project_id,
        "generated_at": utcnow(),
        "markdown": markdown,
        "counts": counts,
    }
