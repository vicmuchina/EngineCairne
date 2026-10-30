from __future__ import annotations

import sqlite3

from cairn.server import db
from cairn.server import activity as activity_store


def test_configure_adds_bootstrap_enabled_to_legacy_projects_table(tmp_path, monkeypatch) -> None:
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                reason_worker TEXT,
                reason_trigger TEXT,
                reason_started_at TEXT,
                reason_last_heartbeat_at TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO projects (id, title, created_at) VALUES ('proj_001', 'legacy', '2026-01-01T00:00:00Z')"
        )

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)

    with db.get_conn() as conn:
        row = conn.execute("SELECT bootstrap_enabled FROM projects WHERE id = 'proj_001'").fetchone()
    assert row["bootstrap_enabled"] == 1


def test_configure_adds_run_id_to_legacy_project_activity(tmp_path, monkeypatch) -> None:
    path = tmp_path / "legacy-project-activity.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                reason_worker TEXT,
                reason_trigger TEXT,
                reason_started_at TEXT,
                reason_last_heartbeat_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE project_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                actor TEXT,
                status TEXT,
                title TEXT NOT NULL,
                description TEXT,
                metadata TEXT,
                source TEXT NOT NULL DEFAULT 'server',
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO projects (id, title, created_at) "
            "VALUES ('proj_001', 'legacy', '2026-01-01T00:00:00Z')"
        )

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)

    with db.get_conn() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(project_activity)")}
        indexes = {row["name"] for row in conn.execute("PRAGMA index_list(project_activity)")}
        activity_store.record_activity(
            conn,
            "proj_001",
            kind="worker_run",
            title="worker started",
            status="running",
            run_id="legacy-run",
        )
        row = conn.execute(
            "SELECT run_id, kind FROM project_activity WHERE project_id = 'proj_001'"
        ).fetchone()
    assert "run_id" in columns
    assert "idx_project_activity_run" in indexes
    assert (row["run_id"], row["kind"]) == ("legacy-run", "worker_run")


def test_configure_maps_disabled_bootstrap_mode_to_false(tmp_path, monkeypatch) -> None:
    path = tmp_path / "intermediate.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                bootstrap_mode TEXT NOT NULL DEFAULT 'auto',
                created_at TEXT NOT NULL,
                reason_worker TEXT,
                reason_trigger TEXT,
                reason_started_at TEXT,
                reason_last_heartbeat_at TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO projects (id, title, bootstrap_mode, created_at) VALUES ('proj_001', 'disabled', 'disabled', '2026-01-01T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO projects (id, title, bootstrap_mode, created_at) VALUES ('proj_002', 'enabled', 'enabled', '2026-01-01T00:00:00Z')"
        )

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)

    with db.get_conn() as conn:
        rows = conn.execute("SELECT id, bootstrap_enabled FROM projects ORDER BY id").fetchall()
    assert [(row["id"], row["bootstrap_enabled"]) for row in rows] == [
        ("proj_001", 0),
        ("proj_002", 1),
    ]
