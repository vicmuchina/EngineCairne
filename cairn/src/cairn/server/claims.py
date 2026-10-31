from __future__ import annotations

"""Stale claim reconciliation for intent workers.

A dispatcher process can die between the claim and the release, leaving ``intents.worker``
set forever. The scheduler historically only expired claims older than the server's
``intent_timeout``; that is both too aggressive for a live run (a temporarily slow
heartbeat) and not explicit about which claims are actually abandoned.

The rule implemented here mirrors the dispatcher contract:

* the intent is open (``concluded_at IS NULL`` and no ``to_fact_id``);
* it has a worker and a parseable heartbeat older than ``claim_stale_seconds``;
* no worker_run for that intent is active (open lifecycle row whose most recent row is
  itself younger than ``claim_stale_seconds``).

Only ``intents.worker`` is cleared. Facts, ``concluded_at``, project status and the
heartbeat are left untouched. A ``stopped`` project is never resumed: this module has no
project-status write at all.
"""

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from cairn.server.services import utcnow


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


def _metadata(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _active_run_pairs(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    now_epoch: float,
    stale_seconds: int,
) -> set[tuple[str | None, str | None]]:
    """(intent_id, worker) pairs protected by an active worker_run.

    A run is active when it has an open ``worker_run`` row and its newest activity row is
    fresher than ``stale_seconds``. This deliberately ignores heartbeats: the whole point
    is to prefer evidence of a live process over a possibly stuck heartbeat thread.
    """
    rows = conn.execute(
        "SELECT * FROM project_activity WHERE project_id = ? AND kind = 'worker_run' "
        "AND run_id IS NOT NULL AND status IN ('running', 'streaming')",
        (project_id,),
    ).fetchall()
    active: set[tuple[str | None, str | None]] = set()
    for row in rows:
        meta = _metadata(row["metadata"])
        last = conn.execute(
            "SELECT MAX(created_at) AS last_at FROM project_activity "
            "WHERE project_id = ? AND run_id = ?",
            (project_id, row["run_id"]),
        ).fetchone()
        last_epoch = _epoch(last["last_at"] if last is not None else row["created_at"])
        if last_epoch is None or now_epoch - last_epoch > stale_seconds:
            continue
        intent_id = meta.get("intent_id")
        worker = meta.get("worker") or row["actor"]
        active.add(
            (
                str(intent_id) if intent_id is not None else None,
                str(worker) if worker is not None else None,
            )
        )
    return active


def reconcile_claims(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    claim_stale_seconds: int = 1800,
    now: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    now_text = now or utcnow()
    now_epoch = _epoch(now_text)
    assert now_epoch is not None
    rows = conn.execute(
        "SELECT id, worker, last_heartbeat_at FROM intents "
        "WHERE project_id = ? AND worker IS NOT NULL AND concluded_at IS NULL "
        "AND to_fact_id IS NULL ORDER BY id",
        (project_id,),
    ).fetchall()
    active = _active_run_pairs(
        conn,
        project_id,
        now_epoch=now_epoch,
        stale_seconds=max(1, int(claim_stale_seconds)),
    )
    released: list[dict[str, str]] = []
    protected = 0
    skipped_fresh = 0
    for row in rows:
        heartbeat = _epoch(row["last_heartbeat_at"])
        if heartbeat is None:
            skipped_fresh += 1
            continue
        if now_epoch - heartbeat <= claim_stale_seconds:
            skipped_fresh += 1
            continue
        pair = (str(row["id"]), str(row["worker"]))
        # Any live run for this intent protects it, even if its worker label differs from
        # the claim (e.g. a worker restarted under another configured name).
        if pair in active or any(
            intent_id == str(row["id"]) for intent_id, _worker in active
        ):
            protected += 1
            continue
        if not dry_run:
            cursor = conn.execute(
                "UPDATE intents SET worker = NULL "
                "WHERE project_id = ? AND id = ? AND worker = ? "
                "AND concluded_at IS NULL AND to_fact_id IS NULL",
                (project_id, row["id"], row["worker"]),
            )
            if int(cursor.rowcount or 0) != 1:
                continue
        released.append({"id": str(row["id"]), "worker": str(row["worker"])})
    return {
        "project_id": project_id,
        "generated_at": now_text,
        "checked": len(rows),
        "released": len(released),
        "protected": protected,
        "skipped_fresh": skipped_fresh,
        "released_intents": released,
    }
