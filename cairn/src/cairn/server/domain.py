"""Generalized Artex domain layer: entities, findings, retests, coverage.

The core Cairn graph is facts -> intents -> facts. This module adds the optional,
domain-neutral objects Artex built on top of that graph:

* **Entity** — a typed referent (host, file, function, dataset, model, …). `kind` and
  `key` are free-form; uniqueness is `(project_id, kind, key)`.
* **Finding** — a claim attached to a fact (and optionally entities), with severity,
  class and a lifecycle status.
* **Retest** — an independent verification session: an intent with `kind='retest'`
  that re-runs the original test and records a verdict (`reproduced|fixed|inconclusive`).

Coverage follows Artex's semantics: the denominator is every *in-scope* entity **plus**
every entity anchored to a fact; the numerator is entities anchored to at least one fact.
Anchoring wins over scope, so testing an out-of-scope entity still counts.

Everything is additive: a project that never writes an entity behaves exactly as before.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Iterable

from cairn.server.activity import record_activity
from cairn.server.models import (
    FINDING_STATUSES,
    RETEST_STATUSES,
    RETEST_VERDICTS,
    SEVERITIES,
)
from cairn.server.services import (
    next_entity_id,
    next_finding_id,
    next_intent_id,
    next_retest_id,
)
from cairn.server.services import utcnow

MAX_TEXT = 200_000


# ------------------------------------------------------------------ helpers


def _clip(text: str | None, limit: int = MAX_TEXT) -> str:
    if not text:
        return ""
    return text if len(text) <= limit else text[:limit] + "\n… [truncated]"


def _load_json(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _dump_json(value: Any) -> str:
    try:
        return json.dumps(value if value is not None else {}, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return "{}"


def _merge_json(existing: str | None, incoming: dict | None) -> str:
    if not incoming:
        return existing or "{}"
    merged = {**_load_json(existing), **_load_json(_dump_json(incoming))}
    return _dump_json(merged)


def _bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in ("0", "false", "no", "off", "")


def _row_to_entity(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["in_scope"] = bool(data.get("in_scope", 1))
    data["metadata"] = _load_json(data.get("metadata"))
    data["fact_count"] = int(data.get("fact_count") or 0)
    data["tested"] = bool(data.get("tested")) or data["fact_count"] > 0
    return data


def _row_to_finding(row: sqlite3.Row, entity_ids: list[str] | None = None) -> dict[str, Any]:
    data = dict(row)
    data["metadata"] = _load_json(data.get("metadata"))
    data["entity_ids"] = entity_ids or []
    data["retests"] = []
    return data


def _row_to_retest(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["snapshot"] = _load_json(data.get("snapshot"))
    return data


def validate_finding(severity: str, status: str) -> None:
    if severity and severity not in SEVERITIES:
        raise ValueError(f"invalid severity: {severity}")
    if status and status not in FINDING_STATUSES:
        raise ValueError(f"invalid finding status: {status}")


def _finding_entity_ids(conn: sqlite3.Connection, project_id: str, finding_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT entity_id FROM finding_entities WHERE project_id = ? AND finding_id = ? ORDER BY entity_id",
        (project_id, finding_id),
    ).fetchall()
    return [row["entity_id"] for row in rows]


def _node_ref(conn: sqlite3.Connection, project_id: str, ref: str) -> str | None:
    """Resolve an entity reference: exact id, `kind:key`, or bare key."""
    text = (ref or "").strip()
    if not text:
        return None
    row = conn.execute(
        "SELECT id FROM entities WHERE project_id = ? AND id = ?", (project_id, text)
    ).fetchone()
    if row is not None:
        return row["id"]
    if ":" in text:
        kind, key = text.split(":", 1)
        row = conn.execute(
            "SELECT id FROM entities WHERE project_id = ? AND kind = ? AND key = ?",
            (project_id, kind.strip(), key.strip()),
        ).fetchone()
        if row is not None:
            return row["id"]
    row = conn.execute(
        "SELECT id FROM entities WHERE project_id = ? AND key = ? ORDER BY id LIMIT 1",
        (project_id, text),
    ).fetchone()
    return row["id"] if row is not None else None


# ---------------------------------------------------------------- entities


ENTITY_SELECT = """
SELECT e.*,
       (SELECT COUNT(*) FROM entity_facts ef
         WHERE ef.project_id = e.project_id AND ef.entity_id = e.id) AS fact_count,
       (EXISTS(SELECT 1 FROM entity_facts ef
                        WHERE ef.project_id = e.project_id AND ef.entity_id = e.id)
                    OR EXISTS(SELECT 1 FROM entity_intents ei
                                JOIN intents i ON i.id = ei.intent_id AND i.project_id = ei.project_id
                               WHERE ei.project_id = e.project_id AND ei.entity_id = e.id
                                 AND i.concluded_at IS NOT NULL)) AS tested
  FROM entities e
"""


def upsert_entity(
    conn: sqlite3.Connection,
    project_id: str,
    payload: dict[str, Any],
    *,
    actor: str | None = None,
) -> dict[str, Any]:
    kind = str(payload.get("kind") or "").strip()
    key = str(payload.get("key") or "").strip()
    if not kind or not key:
        raise ValueError("entity requires kind and key")
    kind = kind[:64]
    key = key[:512]
    now = utcnow()
    label = _clip(str(payload.get("label") or ""), 2000)
    source = str(payload.get("source") or actor or "worker")[:64]
    status = str(payload.get("status") or "discovered")[:64]
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    in_scope_given = payload.get("in_scope") is not None
    status_given = bool(payload.get("status"))
    in_scope = _bool(payload.get("in_scope"), True)

    parent_id = payload.get("parent_id")
    if not parent_id and payload.get("parent_key"):
        parent_kind = payload.get("parent_kind")
        sql = "SELECT id FROM entities WHERE project_id = ? AND key = ?"
        params: list[Any] = [project_id, str(payload["parent_key"])]
        if parent_kind:
            sql += " AND kind = ?"
            params.append(str(parent_kind))
        row = conn.execute(sql + " ORDER BY id LIMIT 1", params).fetchone()
        if row is not None:
            parent_id = row["id"]

    existing = conn.execute(
        "SELECT * FROM entities WHERE project_id = ? AND kind = ? AND key = ?",
        (project_id, kind, key),
    ).fetchone()

    if existing is None:
        entity_id = next_entity_id(conn, project_id)
        conn.execute(
            """
            INSERT INTO entities
                (id, project_id, kind, key, label, parent_id, in_scope, status, source,
                 metadata, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entity_id,
                project_id,
                kind,
                key,
                label,
                str(parent_id) if parent_id else None,
                1 if in_scope else 0,
                status,
                source,
                _dump_json(metadata),
                now,
                now,
            ),
        )
        record_activity(
            conn,
            project_id,
            kind="entity",
            title=f"Entity discovered: {label or key}",
            description=f"{kind} · {key}",
            actor=actor or source,
            status="confirmed",
            metadata={"entity_id": entity_id, "kind": kind, "key": key, "source": source},
            created_at=now,
        )
    else:
        entity_id = existing["id"]
        conn.execute(
            """
            UPDATE entities
               SET label = CASE WHEN ? <> '' THEN ? ELSE label END,
                   parent_id = COALESCE(?, parent_id),
                   in_scope = CASE WHEN ? THEN ? ELSE in_scope END,
                   status = CASE WHEN ? THEN ? ELSE status END,
                   metadata = ?,
                   last_seen_at = ?
             WHERE project_id = ? AND id = ?
            """,
            (
                label,
                label,
                str(parent_id) if parent_id else None,
                1 if in_scope_given else 0,
                1 if in_scope else 0,
                1 if status_given else 0,
                status,
                _merge_json(existing["metadata"], metadata),
                now,
                project_id,
                entity_id,
            ),
        )
        if status_given and status != existing["status"]:
            record_activity(
                conn,
                project_id,
                kind="entity",
                title=f"Entity {entity_id} {status}",
                description=f"{kind} · {key}",
                actor=actor or source,
                status=status,
                metadata={"entity_id": entity_id, "kind": kind, "key": key},
                created_at=now,
            )

    intent_id = payload.get("intent_id")
    if intent_id:
        conn.execute(
            """INSERT OR IGNORE INTO entity_intents
                   (entity_id, project_id, intent_id, relation, created_at)
               VALUES (?, ?, ?, 'tested', ?)""",
            (entity_id, project_id, str(intent_id), now),
        )

    for fact_id in payload.get("facts") or []:
        link_entity_fact(
            conn,
            project_id,
            entity_id,
            str(fact_id),
            source=str(payload.get("source") or "worker"),
            created_at=now,
        )

    row = conn.execute(ENTITY_SELECT + " WHERE e.project_id = ? AND e.id = ?", (project_id, entity_id)).fetchone()
    return _row_to_entity(row)


def link_entity_fact(
    conn: sqlite3.Connection,
    project_id: str,
    entity_id: str,
    fact_id: str,
    *,
    source: str = "worker",
    created_at: str | None = None,
) -> None:
    fact = conn.execute(
        "SELECT 1 FROM facts WHERE project_id = ? AND id = ?", (project_id, fact_id)
    ).fetchone()
    if fact is None:
        raise ValueError(f"fact not found: {fact_id}")
    conn.execute(
        """INSERT OR IGNORE INTO entity_facts
               (entity_id, project_id, fact_id, source, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (entity_id, project_id, fact_id, source[:64], created_at or utcnow()),
    )


def list_entities(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    kind: str | None = None,
    in_scope: bool | None = None,
    tested: bool | None = None,
    q: str | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    sql = ENTITY_SELECT + " WHERE e.project_id = ?"
    params: list[Any] = [project_id]
    if kind:
        sql += " AND e.kind = ?"
        params.append(kind)
    if in_scope is not None:
        sql += " AND e.in_scope = ?"
        params.append(1 if in_scope else 0)
    if q:
        sql += " AND (e.key LIKE ? OR e.label LIKE ?)"
        params.extend([f"%{q}%", f"%{q}%"])
    sql += " ORDER BY e.kind, e.key LIMIT ?"
    params.append(max(1, min(limit, 5000)))
    rows = conn.execute(sql, params).fetchall()
    entities = [_row_to_entity(row) for row in rows]
    if tested is not None:
        entities = [entity for entity in entities if entity["tested"] is tested]
    return entities


def update_entity(
    conn: sqlite3.Connection, project_id: str, entity_id: str, patch: dict[str, Any]
) -> dict[str, Any] | None:
    existing = conn.execute(
        "SELECT * FROM entities WHERE project_id = ? AND id = ?", (project_id, entity_id)
    ).fetchone()
    if existing is None:
        return None
    fields: list[str] = []
    params: list[Any] = []
    if "label" in patch and patch["label"] is not None:
        fields.append("label = ?")
        params.append(_clip(str(patch["label"]), 2000))
    if "parent_id" in patch:
        fields.append("parent_id = ?")
        params.append(str(patch["parent_id"]) if patch["parent_id"] else None)
    if "in_scope" in patch and patch["in_scope"] is not None:
        fields.append("in_scope = ?")
        params.append(1 if _bool(patch["in_scope"]) else 0)
    if "status" in patch and patch["status"] is not None:
        fields.append("status = ?")
        params.append(str(patch["status"])[:64])
    if "metadata" in patch and isinstance(patch["metadata"], dict):
        fields.append("metadata = ?")
        params.append(_merge_json(existing["metadata"], patch["metadata"]))
    if not fields:
        return _row_to_entity(existing)
    fields.append("last_seen_at = ?")
    params.append(utcnow())
    params.extend([project_id, entity_id])
    conn.execute(f"UPDATE entities SET {', '.join(fields)} WHERE project_id = ? AND id = ?", params)
    row = conn.execute(ENTITY_SELECT + " WHERE e.project_id = ? AND e.id = ?", (project_id, entity_id)).fetchone()
    return _row_to_entity(row)


# ---------------------------------------------------------------- findings


def create_finding(
    conn: sqlite3.Connection,
    project_id: str,
    payload: dict[str, Any],
    *,
    actor: str | None = None,
) -> dict[str, Any]:
    title = str(payload.get("title") or "").strip()
    if not title:
        raise ValueError("finding requires a title")
    severity = str(payload.get("severity") or "").strip()
    status = str(payload.get("status") or "pending").strip()
    validate_finding(severity, status)
    now = utcnow()
    finding_id = next_finding_id(conn, project_id)
    fact_id = payload.get("fact_id") or None
    if fact_id:
        fact = conn.execute(
            "SELECT 1 FROM facts WHERE project_id = ? AND id = ?", (project_id, fact_id)
        ).fetchone()
        if fact is None:
            raise ValueError(f"fact not found: {fact_id}")
    intent_id = payload.get("intent_id") or None
    if intent_id:
        intent = conn.execute(
            "SELECT 1 FROM intents WHERE project_id = ? AND id = ?", (project_id, intent_id)
        ).fetchone()
        if intent is None:
            raise ValueError(f"intent not found: {intent_id}")
    entity_id = payload.get("entity_id") or None
    if entity_id:
        entity_id = _node_ref(conn, project_id, str(entity_id))
    conn.execute(
        """
        INSERT INTO findings
            (id, project_id, fact_id, intent_id, entity_id, title, klass, severity,
             summary, evidence, status, worker, metadata, report, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            finding_id,
            project_id,
            fact_id,
            intent_id,
            entity_id,
            _clip(title, 512),
            _clip(str(payload.get("klass") or ""), 200),
            severity,
            _clip(str(payload.get("summary") or "")),
            _clip(str(payload.get("evidence") or "")),
            status,
            str(payload.get("worker") or actor or "")[:128],
            _dump_json(payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}),
            _clip(str(payload.get("report") or "")),
            now,
            now,
        ),
    )
    for ref in payload.get("entities") or []:
        resolved = _node_ref(conn, project_id, str(ref))
        if resolved:
            conn.execute(
                """INSERT OR IGNORE INTO finding_entities (finding_id, entity_id, project_id)
                   VALUES (?, ?, ?)""",
                (finding_id, resolved, project_id),
            )
    record_activity(
        conn,
        project_id,
        kind="finding",
        title=f"Finding recorded: {title}",
        description=_clip(str(payload.get("summary") or payload.get("evidence") or ""), 2000),
        actor=actor or str(payload.get("worker") or "worker"),
        status=status,
        metadata={
            "finding_id": finding_id,
            "severity": severity,
            "klass": str(payload.get("klass") or ""),
            "fact_id": fact_id,
            "entity_id": entity_id,
        },
        created_at=now,
    )
    row = conn.execute(
        "SELECT * FROM findings WHERE project_id = ? AND id = ?", (project_id, finding_id)
    ).fetchone()
    return _row_to_finding(row, _finding_entity_ids(conn, project_id, finding_id))


def list_findings(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    status: str | None = None,
    severity: str | None = None,
    entity_id: str | None = None,
    q: str | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM findings WHERE project_id = ?"
    params: list[Any] = [project_id]
    if status:
        sql += " AND status = ?"
        params.append(status)
    if severity:
        sql += " AND severity = ?"
        params.append(severity)
    if entity_id:
        sql += " AND id IN (SELECT finding_id FROM finding_entities WHERE project_id = ? AND entity_id = ?)"
        params.extend([project_id, entity_id])
    if q:
        sql += " AND (title LIKE ? OR summary LIKE ? OR klass LIKE ?)"
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    params.append(max(1, min(limit, 5000)))
    rows = conn.execute(sql, params).fetchall()
    findings = []
    for row in rows:
        item = _row_to_finding(row, _finding_entity_ids(conn, project_id, row["id"]))
        retests = conn.execute(
            "SELECT id, status, verdict, created_at, finished_at FROM finding_retests "
            "WHERE project_id = ? AND finding_id = ? ORDER BY id DESC LIMIT 5",
            (project_id, row["id"]),
        ).fetchall()
        item["retests"] = [dict(r) for r in retests]
        findings.append(item)
    return findings


def update_finding(
    conn: sqlite3.Connection, project_id: str, finding_id: str, patch: dict[str, Any]
) -> dict[str, Any] | None:
    existing = conn.execute(
        "SELECT * FROM findings WHERE project_id = ? AND id = ?", (project_id, finding_id)
    ).fetchone()
    if existing is None:
        return None
    severity = patch.get("severity", existing["severity"])
    status = patch.get("status", existing["status"])
    validate_finding(str(severity or ""), str(status or ""))
    fields: list[str] = []
    params: list[Any] = []
    for column in ("title", "klass", "severity", "summary", "evidence", "status", "report"):
        if column in patch and patch[column] is not None:
            fields.append(f"{column} = ?")
            params.append(_clip(str(patch[column])))
    if "metadata" in patch and isinstance(patch["metadata"], dict):
        fields.append("metadata = ?")
        params.append(_merge_json(existing["metadata"], patch["metadata"]))
    fields.append("updated_at = ?")
    params.append(utcnow())
    params.extend([project_id, finding_id])
    conn.execute(f"UPDATE findings SET {', '.join(fields)} WHERE project_id = ? AND id = ?", params)
    if status != existing["status"]:
        record_activity(
            conn,
            project_id,
            kind="finding",
            title=f"Finding {finding_id} {status}",
            description=existing["title"],
            actor="human",
            status=str(status),
            metadata={"finding_id": finding_id, "from": existing["status"], "to": status},
        )
    row = conn.execute(
        "SELECT * FROM findings WHERE project_id = ? AND id = ?", (project_id, finding_id)
    ).fetchone()
    return _row_to_finding(row, _finding_entity_ids(conn, project_id, finding_id))


# ----------------------------------------------------------------- retests

RETEST_TEMPLATE = """Re-verify finding {finding_id}: {title}

Severity: {severity}   Class: {klass}
Original summary:
{summary}

Original evidence:
{evidence}

This is a retest, not a new exploration. Re-run the original test with a deterministic
probe (same request/command/input), compare the result with the original evidence, then
report the verdict. Do not broaden the scope unless the original test cannot be repeated.
"""


def create_retest(
    conn: sqlite3.Connection,
    project_id: str,
    finding_id: str,
    *,
    notes: str = "",
    worker: str = "human",
) -> dict[str, Any]:
    finding = conn.execute(
        "SELECT * FROM findings WHERE project_id = ? AND id = ?", (project_id, finding_id)
    ).fetchone()
    if finding is None:
        raise ValueError(f"finding not found: {finding_id}")
    active = conn.execute(
        "SELECT * FROM finding_retests WHERE project_id = ? AND finding_id = ? "
        "AND status IN ('pending','running') ORDER BY id DESC LIMIT 1",
        (project_id, finding_id),
    ).fetchone()
    if active is not None:
        return _row_to_retest(active)

    now = utcnow()
    retest_id = next_retest_id(conn, project_id)
    intent_id = next_intent_id(conn, project_id)
    sources = [finding["fact_id"]] if finding["fact_id"] else []
    if not sources:
        row = conn.execute(
            "SELECT fact_id FROM entity_facts WHERE project_id = ? AND entity_id = ? LIMIT 1",
            (project_id, finding["entity_id"]),
        ).fetchone()
        if row is not None:
            sources = [row["fact_id"]]
    if not sources:
        sources = ["goal"]
    conn.execute(
        """
        INSERT INTO intents
            (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at,
             created_at, concluded_at, priority, kind, retest_of)
        VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, NULL, 10, 'retest', ?)
        """,
        (
            intent_id,
            project_id,
            RETEST_TEMPLATE.format(
                finding_id=finding_id,
                title=finding["title"],
                severity=finding["severity"],
                klass=finding["klass"],
                summary=finding["summary"],
                evidence=finding["evidence"],
            ),
            worker,
            now,
            finding_id,
        ),
    )
    for fact_id in sources:
        conn.execute(
            "INSERT OR IGNORE INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
            (intent_id, project_id, fact_id),
        )
    snapshot = {
        "finding": {
            "id": finding_id,
            "title": finding["title"],
            "severity": finding["severity"],
            "klass": finding["klass"],
            "status": finding["status"],
            "summary": finding["summary"],
            "evidence": finding["evidence"],
        },
        "entity_ids": _finding_entity_ids(conn, project_id, finding_id),
    }
    conn.execute(
        """
        INSERT INTO finding_retests
            (id, project_id, finding_id, intent_id, run_id, status, verdict, notes,
             snapshot, summary, evidence, error, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, NULL, 'pending', '', ?, ?, '', '', '', ?, NULL, NULL)
        """,
        (retest_id, project_id, finding_id, intent_id, _clip(notes, 4000), _dump_json(snapshot), now),
    )
    record_activity(
        conn,
        project_id,
        kind="retest",
        title=f"Retest queued: {finding['title']}",
        description=f"{retest_id} → {finding_id}",
        actor=worker,
        status="pending",
        metadata={"retest_id": retest_id, "finding_id": finding_id, "intent_id": intent_id},
        created_at=now,
    )
    row = conn.execute(
        "SELECT * FROM finding_retests WHERE project_id = ? AND id = ?", (project_id, retest_id)
    ).fetchone()
    return _row_to_retest(row)


def list_retests(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    finding_id: str | None = None,
    status: str | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM finding_retests WHERE project_id = ?"
    params: list[Any] = [project_id]
    if finding_id:
        sql += " AND finding_id = ?"
        params.append(finding_id)
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    params.append(max(1, min(limit, 5000)))
    return [_row_to_retest(row) for row in conn.execute(sql, params).fetchall()]


def start_retest_for_intent(conn: sqlite3.Connection, project_id: str, intent_id: str) -> None:
    conn.execute(
        "UPDATE finding_retests SET status = 'running', started_at = COALESCE(started_at, ?) "
        "WHERE project_id = ? AND intent_id = ? AND status = 'pending'",
        (utcnow(), project_id, intent_id),
    )


def finish_retest_for_intent(
    conn: sqlite3.Connection,
    project_id: str,
    intent_id: str,
    *,
    verdict: str = "",
    summary: str = "",
    evidence: str = "",
    notes: str = "",
    status: str = "completed",
    error: str = "",
    run_id: str | None = None,
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM finding_retests WHERE project_id = ? AND intent_id = ? "
        "ORDER BY id DESC LIMIT 1",
        (project_id, intent_id),
    ).fetchone()
    if row is None:
        return None
    return _finalize_retest(
        conn,
        project_id,
        row,
        verdict=verdict,
        summary=summary,
        evidence=evidence,
        notes=notes,
        status=status,
        error=error,
        run_id=run_id,
    )


def finish_retest(
    conn: sqlite3.Connection,
    project_id: str,
    retest_id: str,
    *,
    verdict: str = "",
    summary: str = "",
    evidence: str = "",
    notes: str = "",
    status: str = "completed",
    error: str = "",
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT * FROM finding_retests WHERE project_id = ? AND id = ?", (project_id, retest_id)
    ).fetchone()
    if row is None:
        return None
    return _finalize_retest(
        conn,
        project_id,
        row,
        verdict=verdict,
        summary=summary,
        evidence=evidence,
        notes=notes,
        status=status,
        error=error,
    )


def _finalize_retest(
    conn: sqlite3.Connection,
    project_id: str,
    row: sqlite3.Row,
    *,
    verdict: str,
    summary: str,
    evidence: str,
    notes: str,
    status: str,
    error: str,
    run_id: str | None = None,
) -> dict[str, Any]:
    if row["status"] in ("completed", "failed", "stopped"):
        # Sealed: a later fallback (e.g. the conclude hook) must never overwrite an
        # explicit verdict that the worker already posted.
        return _row_to_retest(row)
    status = status or "completed"
    if status not in RETEST_STATUSES:
        raise ValueError(f"invalid retest status: {status}")
    verdict = (verdict or "").strip()
    if verdict and verdict not in RETEST_VERDICTS:
        raise ValueError(f"invalid retest verdict: {verdict}")
    if row["status"] in ("completed", "failed", "stopped") and verdict == row["verdict"]:
        # Idempotent: a duplicate result call returns the sealed row.
        return _row_to_retest(row)
    now = utcnow()
    if status == "completed" and not verdict:
        # A retest that produced no explicit verdict is inconclusive, not a failure:
        # the run finished but the worker did not report a comparison.
        verdict = "inconclusive"
    fields = [
        "status = ?",
        "verdict = ?",
        "notes = CASE WHEN ? <> '' THEN ? ELSE notes END",
        "summary = CASE WHEN ? <> '' THEN ? ELSE summary END",
        "evidence = CASE WHEN ? <> '' THEN ? ELSE evidence END",
        "error = ?",
        "finished_at = ?",
        "run_id = COALESCE(?, run_id)",
    ]
    params: list[Any] = [
        status,
        verdict,
        _clip(notes, 4000),
        _clip(notes, 4000),
        _clip(summary),
        _clip(summary),
        _clip(evidence),
        _clip(evidence),
        _clip(error, 4000),
        now,
        run_id,
        project_id,
        row["id"],
    ]
    conn.execute(
        f"UPDATE finding_retests SET {', '.join(fields)} WHERE project_id = ? AND id = ?",
        params,
    )
    if verdict in ("reproduced", "fixed"):
        new_status = "confirmed" if verdict == "reproduced" else "fixed"
        conn.execute(
            "UPDATE findings SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?",
            (new_status, now, project_id, row["finding_id"]),
        )
        record_activity(
            conn,
            project_id,
            kind="finding",
            title=f"Finding {row['finding_id']} {new_status} after retest",
            description=f"{row['id']} verdict={verdict}",
            actor="retester",
            status=new_status,
            metadata={"finding_id": row["finding_id"], "retest_id": row["id"], "verdict": verdict},
            created_at=now,
        )
    record_activity(
        conn,
        project_id,
        kind="retest",
        title=f"Retest {row['id']} {status}",
        description=f"verdict={verdict or 'none'}",
        actor="retester",
        status=status,
        metadata={
            "retest_id": row["id"],
            "finding_id": row["finding_id"],
            "verdict": verdict,
            "status": status,
        },
        created_at=now,
    )
    updated = conn.execute(
        "SELECT * FROM finding_retests WHERE project_id = ? AND id = ?", (project_id, row["id"])
    ).fetchone()
    return _row_to_retest(updated)


# ---------------------------------------------------------------- coverage


def compute_coverage(
    conn: sqlite3.Connection, project_id: str, *, untested_limit: int = 20
) -> dict[str, Any]:
    """Artex semantics: denominator = in-scope ∪ anchored; numerator = anchored to a fact."""
    rows = conn.execute(
        """
        SELECT e.kind AS kind,
               COUNT(*) AS total,
               SUM(CASE WHEN (EXISTS(SELECT 1 FROM entity_facts ef
                        WHERE ef.project_id = e.project_id AND ef.entity_id = e.id)
                    OR EXISTS(SELECT 1 FROM entity_intents ei
                                JOIN intents i ON i.id = ei.intent_id AND i.project_id = ei.project_id
                               WHERE ei.project_id = e.project_id AND ei.entity_id = e.id
                                 AND i.concluded_at IS NOT NULL)) THEN 1 ELSE 0 END) AS tested
          FROM entities e
         WHERE e.project_id = ?
           AND (e.in_scope = 1 OR (EXISTS(SELECT 1 FROM entity_facts ef
                        WHERE ef.project_id = e.project_id AND ef.entity_id = e.id)
                    OR EXISTS(SELECT 1 FROM entity_intents ei
                                JOIN intents i ON i.id = ei.intent_id AND i.project_id = ei.project_id
                               WHERE ei.project_id = e.project_id AND ei.entity_id = e.id
                                 AND i.concluded_at IS NOT NULL)))
         GROUP BY e.kind
         ORDER BY e.kind
        """,
        (project_id,),
    ).fetchall()
    by_kind = [
        {"kind": row["kind"], "total": int(row["total"]), "tested": int(row["tested"] or 0)}
        for row in rows
    ]
    denominator = sum(item["total"] for item in by_kind)
    tested = sum(item["tested"] for item in by_kind)
    scope_rows = conn.execute(
        "SELECT COUNT(*) AS n FROM entities WHERE project_id = ? AND in_scope = 1",
        (project_id,),
    ).fetchone()["n"]
    untested = []
    if untested_limit > 0:
        for item in conn.execute(
            """
            SELECT e.id, e.kind, e.key, e.label, e.in_scope
              FROM entities e
             WHERE e.project_id = ?
               AND (e.in_scope = 1 OR (EXISTS(SELECT 1 FROM entity_facts ef
                        WHERE ef.project_id = e.project_id AND ef.entity_id = e.id)
                    OR EXISTS(SELECT 1 FROM entity_intents ei
                                JOIN intents i ON i.id = ei.intent_id AND i.project_id = ei.project_id
                               WHERE ei.project_id = e.project_id AND ei.entity_id = e.id
                                 AND i.concluded_at IS NOT NULL)))
               AND NOT (EXISTS(SELECT 1 FROM entity_facts ef
                        WHERE ef.project_id = e.project_id AND ef.entity_id = e.id)
                    OR EXISTS(SELECT 1 FROM entity_intents ei
                                JOIN intents i ON i.id = ei.intent_id AND i.project_id = ei.project_id
                               WHERE ei.project_id = e.project_id AND ei.entity_id = e.id
                                 AND i.concluded_at IS NOT NULL))
             ORDER BY e.in_scope DESC, e.kind, e.key
             LIMIT ?
            """,
            (project_id, untested_limit),
        ).fetchall():
            entry = dict(item)
            entry["in_scope"] = bool(entry.get("in_scope"))
            untested.append(entry)
    return {
        "enabled": True,
        "scope_rows": int(scope_rows or 0),
        "denominator": denominator,
        "tested": tested,
        "pct": (tested / denominator) if denominator else None,
        "by_kind": by_kind,
        "untested": untested,
    }


def coverage_graph(conn: sqlite3.Connection, project_id: str) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT e.id, e.kind, e.key, e.label, e.parent_id, e.in_scope,
               (EXISTS(SELECT 1 FROM entity_facts ef
                        WHERE ef.project_id = e.project_id AND ef.entity_id = e.id)
                    OR EXISTS(SELECT 1 FROM entity_intents ei
                                JOIN intents i ON i.id = ei.intent_id AND i.project_id = ei.project_id
                               WHERE ei.project_id = e.project_id AND ei.entity_id = e.id
                                 AND i.concluded_at IS NOT NULL)) AS tested
          FROM entities e
         WHERE e.project_id = ?
         ORDER BY e.kind, e.key
        """,
        (project_id,),
    ).fetchall()
    nodes = []
    edges = []
    by_id = {row["id"]: row for row in rows}
    for row in rows:
        nodes.append(
            {
                "key": f"e:{row['id']}",
                "id": row["id"],
                "kind": row["kind"],
                "label": row["label"] or row["key"],
                "tested": bool(row["tested"]),
                "in_scope": bool(row["in_scope"]),
                "parent_id": row["parent_id"],
            }
        )
        if row["parent_id"] and row["parent_id"] in by_id:
            edges.append({"src": f"e:{row['id']}", "dst": f"e:{row['parent_id']}"})
    return {"nodes": nodes, "edges": edges}


# ---------------------------------------------------------------- bundle


def domain_bundle(conn: sqlite3.Connection, project_id: str) -> dict[str, Any]:
    """Compact domain view for GET /projects/{id} (UI + planner context)."""
    return {
        "entities": list_entities(conn, project_id, limit=1000),
        "findings": list_findings(conn, project_id, limit=500),
        "retests": list_retests(conn, project_id, limit=500),
        "coverage": compute_coverage(conn, project_id),
    }


def format_scope_context(conn: sqlite3.Connection, project_id: str) -> str:
    """Planner prompt section: coverage, uncovered entities, findings, active retests."""
    coverage = compute_coverage(conn, project_id, untested_limit=40)
    if coverage["denominator"] == 0 and coverage["scope_rows"] == 0:
        return "(no typed entities recorded yet)"
    lines = [
        f"Coverage: {coverage['tested']}/{coverage['denominator']} tested"
        + (f" ({coverage['pct'] * 100:.0f}%)" if coverage["pct"] is not None else ""),
        "By kind: "
        + (", ".join(f"{k['kind']} {k['tested']}/{k['total']}" for k in coverage["by_kind"]) or "none"),
    ]
    if coverage["untested"]:
        lines.append("Uncovered in-scope entities:")
        for item in coverage["untested"]:
            lines.append(f"- [{item['kind']}] {item['label'] or item['key']} ({item['id']})")
    findings = list_findings(conn, project_id, status="pending", limit=20)
    for status in ("confirmed", "in_progress"):
        findings += list_findings(conn, project_id, status=status, limit=20)
    if findings:
        lines.append("Findings without a final disposition:")
        for finding in findings[:20]:
            lines.append(
                f"- {finding['id']} [{finding['severity'] or '?'}] {finding['title']} "
                f"({finding['status']})"
            )
    retests = [r for r in list_retests(conn, project_id, limit=50) if r["status"] in ("pending", "running")]
    if retests:
        lines.append("Retests waiting/running:")
        for retest in retests:
            lines.append(f"- {retest['id']} for finding {retest['finding_id']} ({retest['status']})")
    return "\n".join(lines)
