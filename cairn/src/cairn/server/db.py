from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Generator

DEFAULT_DB = Path.home() / ".local" / "share" / "cairn" / "cairn.db"

_db_path: Path | None = None

SCHEMA = """\
CREATE TABLE IF NOT EXISTS settings (
    intent_timeout INTEGER NOT NULL DEFAULT 15,
    reason_timeout INTEGER NOT NULL DEFAULT 15
);

INSERT OR IGNORE INTO settings (rowid, intent_timeout, reason_timeout) VALUES (1, 15, 15);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    bootstrap_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    reason_worker TEXT,
    reason_trigger TEXT,
    reason_started_at TEXT,
    reason_last_heartbeat_at TEXT
);

CREATE TABLE IF NOT EXISTS facts (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS intents (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    to_fact_id TEXT,
    description TEXT NOT NULL,
    creator TEXT NOT NULL,
    worker TEXT,
    last_heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    concluded_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS intent_sources (
    intent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (intent_id, project_id, fact_id),
    FOREIGN KEY (intent_id, project_id) REFERENCES intents(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hints (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    creator TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('project', 0);

CREATE TABLE IF NOT EXISTS scoped_counters (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, kind)
);

CREATE TABLE IF NOT EXISTS chat_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    pi_session_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_project
    ON chat_conversations (project_id, created_at);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'done',
    error TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
    ON chat_messages (conversation_id, seq);

CREATE TABLE IF NOT EXISTS chat_runs (
    id TEXT PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
    pid INTEGER,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER,
    stderr_tail TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    turns INTEGER,
    tool_calls INTEGER,
    model TEXT,
    pid_start_ticks INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chat_runs_conversation
    ON chat_runs (conversation_id, started_at);

-- Step-level trace of a pi turn (pi --mode json event stream, persisted as it arrives).
-- chat_messages stays the user/assistant turn; activities are the intermediate steps.
CREATE TABLE IF NOT EXISTS chat_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    message_id INTEGER,
    run_id TEXT,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    role TEXT,
    content TEXT,
    tool_name TEXT,
    tool_call_id TEXT,
    tool_input TEXT,
    tool_output TEXT,
    status TEXT NOT NULL DEFAULT 'done',
    error TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    created_at TEXT NOT NULL,
    raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_activities_conversation
    ON chat_activities (conversation_id, seq);

CREATE INDEX IF NOT EXISTS idx_chat_activities_run
    ON chat_activities (run_id, id);

-- Events that are not derivable from the fact graph itself (worker lifecycle, steering
-- delivery, approvals, status changes, ...). Facts/intents/hints are derived from their
-- own tables by the activity feed; this table only holds what those tables cannot express.
CREATE TABLE IF NOT EXISTS project_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    actor TEXT,
    status TEXT,
    title TEXT NOT NULL,
    description TEXT,
    metadata TEXT,
    source TEXT NOT NULL DEFAULT 'server',
    created_at TEXT NOT NULL,
    -- Worker observability: one dispatcher process run plus its transcript rows.
    -- NULL for every non-worker event (facts/steering/approvals/status/...).
    run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_activity_project
    ON project_activity (project_id, created_at);

CREATE TABLE IF NOT EXISTS steering (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intent_id TEXT,
    message TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    delivered_at TEXT,
    delivered_to TEXT,
    delivered_run TEXT
);

CREATE INDEX IF NOT EXISTS idx_steering_project
    ON steering (project_id, status, created_at);

CREATE TABLE IF NOT EXISTS approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id INTEGER,
    action TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    decision_note TEXT,
    expires_at TEXT,
    metadata TEXT,
    action_hash TEXT,
    consumed_at TEXT,
    consumed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_project
    ON approval_requests (project_id, status, requested_at);

-- Bulk expiry scans "pending rows whose expires_at has passed".
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending_expiry
    ON approval_requests (status, expires_at);

-- =====================================================================
-- Domain layer: typed entities, findings, retests (generalized Artex).
-- Optional and additive: a project with no entities behaves as before.
-- =====================================================================

CREATE TABLE IF NOT EXISTS entities (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    in_scope INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'discovered',
    source TEXT NOT NULL DEFAULT 'worker',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id),
    UNIQUE (project_id, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_entities_project_kind
    ON entities (project_id, kind);
CREATE INDEX IF NOT EXISTS idx_entities_parent
    ON entities (project_id, parent_id);

CREATE TABLE IF NOT EXISTS entity_facts (
    entity_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fact_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'worker',
    created_at TEXT NOT NULL,
    PRIMARY KEY (entity_id, fact_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_facts_fact
    ON entity_facts (project_id, fact_id);

CREATE TABLE IF NOT EXISTS entity_intents (
    entity_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intent_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'tested',
    created_at TEXT NOT NULL,
    PRIMARY KEY (entity_id, intent_id, project_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_entity_intents_intent
    ON entity_intents (project_id, intent_id);

CREATE TABLE IF NOT EXISTS findings (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fact_id TEXT,
    intent_id TEXT,
    entity_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    klass TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    worker TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    report TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_findings_project_status
    ON findings (project_id, status, created_at);

CREATE TABLE IF NOT EXISTS finding_entities (
    finding_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (finding_id, entity_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_finding_entities_entity
    ON finding_entities (project_id, entity_id);

CREATE TABLE IF NOT EXISTS finding_retests (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    finding_id TEXT NOT NULL,
    intent_id TEXT,
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    verdict TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    PRIMARY KEY (id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_finding_retests_history
    ON finding_retests (project_id, finding_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_retests_active
    ON finding_retests (project_id, finding_id)
    WHERE status IN ('pending', 'running');
"""


def current_path() -> Path:
    """Return the configured SQLite path (used for run/session directories)."""
    assert _db_path is not None
    return _db_path


def configure(path: Path) -> None:
    global _db_path
    if _db_path is not None:
        return
    _db_path = path
    _db_path.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _ensure_project_columns(conn)
        _ensure_columns(
            conn,
            "intents",
            {
                "priority": "INTEGER NOT NULL DEFAULT 0",
                # Domain layer: a retest is an intent that re-verifies a finding and
                # records a verdict. Existing intents default to a normal exploration.
                "kind": "TEXT NOT NULL DEFAULT 'explore'",
                "retest_of": "TEXT",
            },
        )
        _ensure_columns(
            conn,
            "chat_messages",
            {"tokens_in": "INTEGER", "tokens_out": "INTEGER"},
        )
        _ensure_columns(
            conn,
            "chat_runs",
            {
                "tokens_in": "INTEGER",
                "tokens_out": "INTEGER",
                "turns": "INTEGER",
                "tool_calls": "INTEGER",
                "model": "TEXT",
                # v3: JSONL replay after a crash/server restart. ``log_offset`` is the byte
                # offset already persisted as chat_activities; ``mode`` is json|rpc.
                "log_path": "TEXT",
                "log_offset": "INTEGER NOT NULL DEFAULT 0",
                "mode": "TEXT",
                # v3.1: process identity for the startup sweep. ``pid`` alone is not enough:
                # a recycled PID may belong to an unrelated pi/B44 worker/interactive pi.
                "pid_start_ticks": "INTEGER",
            },
        )
        _ensure_columns(
            conn,
            "approval_requests",
            {
                # v3: the approval is bound to one exact action payload, and can be
                # consumed exactly once by the execution layer.
                "action_hash": "TEXT",
                "consumed_at": "TEXT",
                "consumed_by": "TEXT",
            },
        )
        _ensure_worker_activity_columns(conn)


def _ensure_worker_activity_columns(conn: sqlite3.Connection) -> None:
    """Worker transcript rows group by ``run_id``; add it in place on old databases.

    The index must be created after the ALTER TABLE (a legacy table has no ``run_id``),
    so it cannot live in SCHEMA — executescript would fail on the old schema.
    """
    _ensure_columns(conn, "project_activity", {"run_id": "TEXT"})
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_activity_run "
        "ON project_activity (project_id, run_id, id)"
    )


def _ensure_columns(
    conn: sqlite3.Connection, table: str, columns: dict[str, str]
) -> None:
    """Add missing columns in place (idempotent, backward compatible)."""
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if not existing:
        return
    for name, ddl in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def _ensure_project_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}
    if "bootstrap_enabled" not in columns:
        conn.execute("ALTER TABLE projects ADD COLUMN bootstrap_enabled INTEGER NOT NULL DEFAULT 1")
        if "bootstrap_mode" in columns:
            conn.execute(
                "UPDATE projects SET bootstrap_enabled = CASE WHEN bootstrap_mode = 'disabled' THEN 0 ELSE 1 END"
            )


@contextmanager
def get_conn() -> Generator[sqlite3.Connection, None, None]:
    assert _db_path is not None
    conn = sqlite3.connect(str(_db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
