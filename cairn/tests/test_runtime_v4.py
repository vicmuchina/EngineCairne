from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cairn.dispatcher.config import DispatchConfig
from cairn.dispatcher.runtime.process import ProcessResult
from cairn.dispatcher.runtime.supervisor import ProcessSupervisor
from cairn.dispatcher.scheduler.watchdog import WATCHDOG_EXIT_CODE, LoopWatchdog
from cairn.dispatcher.workers.activity import WorkerActivityRecorder
from cairn.dispatcher.workers.pi_events import PiWorkerEventParser
from cairn.server import db
from cairn.server import sessions as session_store
from cairn.server.app import app

from conftest import FakeClient, make_config, make_project


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "cairn.db")
    with TestClient(app) as test_client:
        yield test_client


def _project(client: TestClient) -> str:
    response = client.post(
        "/projects", json={"title": "runtime-v4", "origin": "start", "goal": "finish"}
    )
    assert response.status_code == 201, response.text
    return response.json()["project"]["id"]


def _activity(client: TestClient, project_id: str, **payload) -> dict:
    response = client.post(f"/projects/{project_id}/activity", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _now(delta_seconds: int = 0) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")


def _insert_intent(
    project_id: str,
    intent_id: str,
    *,
    worker: str | None,
    heartbeat: str | None,
    concluded_at: str | None = None,
) -> None:
    with db.get_conn() as conn:
        conn.execute(
            "INSERT INTO intents "
            "(id, project_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) "
            "VALUES (?, ?, ?, 'tester', ?, ?, ?, ?)",
            (intent_id, project_id, f"work {intent_id}", worker, heartbeat, heartbeat, concluded_at),
        )
        conn.execute(
            "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, 'origin')",
            (intent_id, project_id),
        )


# ----------------------------------------------------- stale claim reconciliation


def test_stale_claim_reconciliation_releases_only_abandoned_open_intents(client: TestClient) -> None:
    project_id = _project(client)
    old = _now(-7200)
    _insert_intent(project_id, "i-stale", worker="w1", heartbeat=old)
    _insert_intent(project_id, "i-fresh", worker="w1", heartbeat=_now())
    _insert_intent(project_id, "i-active", worker="w1", heartbeat=old)
    _insert_intent(
        project_id, "i-concluded", worker="w1", heartbeat=old, concluded_at=_now(-100000)
    )
    # A live run for i-active protects it even though its heartbeat is old (this is the
    # signal a stuck heartbeat thread must not get the claim released under a live worker).
    _activity(
        client,
        project_id,
        kind="worker_run",
        title="explore worker pi-1 started",
        status="running",
        actor="pi-1",
        run_id="run-live",
        metadata={"task": "explore", "intent_id": "i-active", "worker": "pi-1"},
    )

    response = client.post(
        f"/projects/{project_id}/claims/reconcile",
        json={"claim_stale_seconds": 1800},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["released"] == 1
    assert payload["protected"] == 1
    assert payload["released_intents"] == [{"id": "i-stale", "worker": "w1"}]

    with db.get_conn() as conn:
        rows = {
            row["id"]: row
            for row in conn.execute(
                "SELECT id, worker, concluded_at FROM intents WHERE project_id = ?",
                (project_id,),
            )
        }
        project = conn.execute(
            "SELECT status FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
    assert rows["i-stale"]["worker"] is None
    assert rows["i-fresh"]["worker"] == "w1"
    assert rows["i-active"]["worker"] == "w1"
    assert rows["i-concluded"]["worker"] == "w1"
    assert rows["i-concluded"]["concluded_at"] is not None
    assert project["status"] == "active"

    # Idempotent and non-destructive on the second pass.
    again = client.post(
        f"/projects/{project_id}/claims/reconcile",
        json={"claim_stale_seconds": 1800},
    ).json()
    assert again["released"] == 0
    assert again["protected"] == 1

    # dry_run reports without writing.
    _insert_intent(project_id, "i-dry", worker="w1", heartbeat=old)
    dry = client.post(
        f"/projects/{project_id}/claims/reconcile",
        json={"claim_stale_seconds": 1800, "dry_run": True},
    ).json()
    assert dry["released"] == 1
    with db.get_conn() as conn:
        assert conn.execute(
            "SELECT worker FROM intents WHERE project_id = ? AND id = 'i-dry'", (project_id,)
        ).fetchone()["worker"] == "w1"


def test_stale_claim_reconciliation_never_resumes_a_stopped_project(client: TestClient) -> None:
    project_id = _project(client)
    _insert_intent(project_id, "i001", worker="w1", heartbeat=_now(-7200))
    assert client.put(
        f"/projects/{project_id}/status", json={"status": "stopped"}
    ).status_code == 200
    # Stopping already releases open workers; force one back to prove reconcile only
    # touches the claim column and never the status.
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE intents SET worker = 'w1', last_heartbeat_at = ? WHERE project_id = ?",
            (_now(-7200), project_id),
        )
    payload = client.post(
        f"/projects/{project_id}/claims/reconcile",
        json={"claim_stale_seconds": 1800},
    ).json()
    assert payload["released"] == 1
    detail = client.get(f"/projects/{project_id}").json()
    assert detail["project"]["status"] == "stopped"
    assert detail["intents"][0]["worker"] is None


# --------------------------------------------------------------------- watchdog


def test_watchdog_exits_75_only_after_timeout_with_fake_clock() -> None:
    exits: list[int] = []
    now = [1000.0]
    watchdog = LoopWatchdog(
        120,
        clock=lambda: now[0],
        exit_fn=exits.append,
        check_interval_seconds=0.05,
    )
    assert watchdog.check(now=1119.0) is False
    assert watchdog.check(now=1120.0) is False
    assert exits == []
    now[0] = 1120.01
    assert watchdog.check() is True
    assert exits == [WATCHDOG_EXIT_CODE]
    # A tripped watchdog stays tripped and never calls exit twice.
    assert watchdog.check(now=9999.0) is True
    assert exits == [WATCHDOG_EXIT_CODE]


def test_watchdog_config_defaults_are_used_and_sleep_keeps_it_alive() -> None:
    config = make_config()
    assert config.runtime.watchdog_seconds == 120
    assert config.runtime.claim_stale_seconds == 1800
    assert config.runtime.claim_reconcile_interval == 300
    exits: list[int] = []
    now = [0.0]
    watchdog = LoopWatchdog(5, clock=lambda: now[0], exit_fn=exits.append)
    watchdog.sleep(0)  # no-op
    now[0] = 1.0
    assert watchdog.check() is False


# --------------------------------------------------------- process supervisor


class _FakeProcess:
    def __init__(self) -> None:
        self.killed = threading.Event()
        self.timed_out = False

    def mark_timed_out(self) -> None:
        self.timed_out = True

    def kill(self) -> None:
        self.killed.set()


def test_process_supervisor_kills_and_marks_timeout_independently() -> None:
    process = _FakeProcess()
    called: list[str] = []
    supervisor = ProcessSupervisor(
        process,
        timeout_seconds=0.05,
        grace_seconds=0.0,
        label="test",
        on_timeout=lambda: called.append("timeout"),
    )
    supervisor.start()
    assert process.killed.wait(1.0), "supervisor did not kill the process at its deadline"
    assert process.timed_out is True
    assert called == ["timeout"]
    supervisor.stop()


def test_process_supervisor_does_not_fire_for_a_finished_process() -> None:
    process = _FakeProcess()
    supervisor = ProcessSupervisor(process, timeout_seconds=5, grace_seconds=0)
    supervisor.start()
    supervisor.stop()
    assert process.killed.is_set() is False
    assert process.timed_out is False


# ----------------------------------------------------------- usage aggregation


def test_recorder_aggregates_usage_and_model_across_messages() -> None:
    parser = PiWorkerEventParser("pi-1")
    recorder = WorkerActivityRecorder(
        FakeClient(make_project()),
        project_id="proj_001",
        worker="pi-1",
        task="explore",
        intent_id="i001",
        parser=parser,
    )
    recorder.start()
    for event in (
        {"type": "message_start", "message": {"role": "assistant", "model": "deepseek-v4.1-flash"}},
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "first"}],
                "model": "deepseek-v4.1-flash",
                "stopReason": "stop",
                "usage": {
                    "input": 10,
                    "output": 2,
                    "cacheRead": 4,
                    "cacheWrite": 1,
                    "reasoning": 3,
                    "totalTokens": 20,
                    "cost": 0.01,
                },
            },
        },
        {"type": "message_start", "message": {"role": "assistant", "model": "deepseek-v4.1-flash"}},
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "second"}],
                "model": "deepseek-v4.1-flash",
                "stopReason": "stop",
                "usage": {"input": 5, "output": 1, "cacheRead": 2, "cost": 0.02},
            },
        },
    ):
        recorder.feed_event(event)
    recorder.finish(
        result=ProcessResult(returncode=0, stdout="", stderr=""),
        session="sess-1",
    )

    client = recorder.client
    close = next(a for a in client.activities if a.get("kind") == "close")
    assert close["metadata"]["model"] == "deepseek-v4.1-flash"
    assert close["metadata"]["usage"] == {
        "input": 15,
        "output": 3,
        "cache_read": 6,
        "cache_write": 1,
        "reasoning": 3,
        "total_tokens": 20,
        "cost": 0.03,
    }
    assert recorder.usage["input"] == 15


def test_worker_endpoint_exposes_run_usage_and_model(client: TestClient) -> None:
    project_id = _project(client)
    _activity(
        client,
        project_id,
        kind="worker_run",
        title="explore worker pi-1 started",
        status="running",
        actor="pi-1",
        run_id="run-usage",
        metadata={
            "task": "explore",
            "worker": "pi-1",
            "model": "deepseek-v4.1-flash",
            "usage": {
                "input": 100,
                "output": 20,
                "cache_read": 80,
                "cache_write": 2,
                "reasoning": 4,
                "total_tokens": 200,
                "cost": 1.25,
            },
        },
    )
    item = client.get(f"/projects/{project_id}/workers").json()["items"][0]
    assert item["model"] == "deepseek-v4.1-flash"
    assert item["usage"]["input"] == 100
    assert item["usage"]["cache_read"] == 80
    assert item["usage"]["cost"] == 1.25

    # Older runs without the finish block are recomputed from message_end metadata.
    _activity(
        client,
        project_id,
        kind="worker_run",
        title="explore worker pi-2 started",
        status="done",
        actor="pi-2",
        run_id="run-old",
        metadata={"task": "explore", "worker": "pi-2"},
    )
    _activity(
        client,
        project_id,
        kind="worker_message",
        title="message",
        status="done",
        actor="pi-2",
        run_id="run-old",
        description="done",
        metadata={"model": "m2", "usage": {"input": 7, "output": 3, "cacheRead": 5, "cost": 0.1}},
    )
    old = next(i for i in client.get(f"/projects/{project_id}/workers").json()["items"] if i["run_id"] == "run-old")
    assert old["model"] == "m2"
    assert old["usage"]["input"] == 7
    assert old["usage"]["cache_read"] == 5
    assert old["usage"]["cost"] == 0.1


# --------------------------------------------------------------- sessions API


def _seed_main_conversation(project_id: str, count: int = 5) -> int:
    with db.get_conn() as conn:
        cursor = conn.execute(
            "INSERT INTO chat_conversations "
            "(project_id, title, pi_session_id, status, created_at, updated_at) "
            "VALUES (?, 'New conversation', 'sess-main', 'idle', ?, ?)",
            (project_id, _now(-100), _now(-10)),
        )
        conversation_id = int(cursor.lastrowid)
        for index in range(1, count + 1):
            conn.execute(
                "INSERT INTO chat_activities "
                "(conversation_id, seq, kind, role, content, status, created_at) "
                "VALUES (?, ?, 'message', 'assistant', ?, 'done', ?)",
                (conversation_id, index, f"main message {index}", _now(-100 + index)),
            )
        return conversation_id


def test_sessions_mapping_orders_main_plan_workers_system_with_tokens(client: TestClient) -> None:
    project_id = _project(client)
    _seed_main_conversation(project_id, count=2)
    _activity(
        client,
        project_id,
        kind="worker_run",
        title="explore worker pi-1 started",
        status="running",
        actor="pi-1",
        run_id="run-abcdef1234567890",
        metadata={
            "task": "explore",
            "worker": "pi-1",
            "intent_id": "i001",
            "intent_description": "investigate the thing",
            "started_at": _now(-30),
            "usage": {"input": 100, "output": 10, "cacheRead": 50, "cost": 0.25},
            "model": "deepseek-v4.1-flash",
        },
    )
    _activity(
        client,
        project_id,
        kind="worker_message",
        title="message",
        status="done",
        actor="pi-1",
        run_id="run-abcdef1234567890",
        description="working",
    )
    _activity(
        client,
        project_id,
        kind="worker_run",
        title="reason worker pi-1 started",
        status="running",
        actor="pi-1",
        run_id="run-reason-1",
        metadata={
            "task": "reason",
            "worker": "pi-1",
            "started_at": _now(-60),
            "usage": {"input": 20, "output": 5, "cacheRead": 10, "cost": 0.05},
        },
    )
    _activity(
        client,
        project_id,
        kind="status",
        title="Project status changed to active",
        status="active",
        actor="human",
    )

    payload = client.get(f"/projects/{project_id}/sessions").json()
    assert payload["project_status"] == "active"
    keys = [session["key"] for session in payload["sessions"]]
    assert keys[:2] == ["main", "plan"]
    assert keys[-1] == "system"
    assert keys[2].startswith("worker:")

    main, plan, worker, system = payload["sessions"][:4]
    assert main["role"] == "mainagent"
    assert main["title"] == "Main agent - conversation #1"
    assert [step["kind"] for step in client.get(
        f"/projects/{project_id}/sessions/main/activities"
    ).json()["items"]] == ["message", "message"]

    assert plan["role"] == "planner"
    assert plan["title"] == "Planner - situation assessment"
    assert plan["tokens"] == {"input": 20, "cache_read": 10, "output": 5, "cost": 0.05}

    assert worker["role"] == "worker"
    assert worker["run_id"] == "run-abcdef1234567890"
    assert worker["title"].startswith("#run-abcd")
    assert "investigate the thing" in worker["title"]
    assert worker["tokens"] == {"input": 100, "cache_read": 50, "output": 10, "cost": 0.25}
    assert worker["model"] == "deepseek-v4.1-flash"
    assert worker["counts"]["messages"] == 1
    assert system["role"] == "system"
    assert system["title"] == "System audit"

    # task_total is the sum over every lane.
    assert payload["task_total"] == {
        "input": 120,
        "cache_read": 60,
        "output": 15,
        "cost": 0.3,
    }


def test_sessions_activities_paginate_backwards_and_map_tools(client: TestClient) -> None:
    project_id = _project(client)
    _seed_main_conversation(project_id, count=5)
    page = client.get(
        f"/projects/{project_id}/sessions/main/activities", params={"limit": 2}
    ).json()
    assert [item["seq"] for item in page["items"]] == [4, 5]
    assert page["has_more"] is True
    assert page["earliest_seq"] == 4

    older = client.get(
        f"/projects/{project_id}/sessions/main/activities",
        params={"before": page["earliest_seq"], "limit": 2},
    ).json()
    assert [item["seq"] for item in older["items"]] == [2, 3]
    assert older["has_more"] is True

    oldest = client.get(
        f"/projects/{project_id}/sessions/main/activities",
        params={"before": older["earliest_seq"], "limit": 2},
    ).json()
    assert [item["seq"] for item in oldest["items"]] == [1]
    assert oldest["has_more"] is False

    # Worker tool rows map to the Artex tool object, paired by call id.
    _activity(
        client,
        project_id,
        kind="worker_run",
        title="explore worker pi-1 started",
        status="running",
        actor="pi-1",
        run_id="run-tools",
        metadata={"task": "explore", "intent_description": "tools"},
    )
    _activity(
        client,
        project_id,
        kind="tool_call",
        title="Tool bash",
        status="done",
        actor="pi-1",
        run_id="run-tools",
        description='{"command": "echo hi"}',
        metadata={"tool_name": "bash", "tool_call_id": "c1", "tool_input": '{"command": "echo hi"}'},
    )
    _activity(
        client,
        project_id,
        kind="tool_result",
        title="Tool bash result",
        status="done",
        actor="pi-1",
        run_id="run-tools",
        description="hi\n",
        metadata={
            "tool_name": "bash",
            "tool_call_id": "c1",
            "tool_output": "hi\n",
            "duration_ms": 12,
            "is_error": False,
        },
    )
    worker_page = client.get(
        f"/projects/{project_id}/sessions/worker:run-tools/activities"
    ).json()
    assert [item["kind"] for item in worker_page["items"]] == ["tool_call", "tool_result"]
    call, result = worker_page["items"]
    assert call["tool"]["call_id"] == "c1"
    assert call["tool"]["input"] == '{"command": "echo hi"}'
    assert result["tool"]["output"] == "hi\n"
    assert result["tool"]["duration_ms"] == 12
    assert worker_page["earliest_seq"] == call["seq"]
    assert client.get(
        f"/projects/{project_id}/sessions/worker:missing/activities"
    ).status_code == 404


# --------------------------------------------------------------------- SSE


def test_sse_framing_is_stable_and_json_escaped() -> None:
    frame = session_store.format_sse_activity(
        event_id=42,
        key="worker:abc",
        seq=42,
        activity={"kind": "message", "content": 'héllo\n"world"'},
    )
    assert frame.startswith("id: 42\nevent: activity\ndata: ")
    assert frame.endswith("\n\n")
    data_line = frame.split("data: ", 1)[1].strip()
    decoded = json.loads(data_line)
    assert decoded == {
        "key": "worker:abc",
        "seq": 42,
        "activity": {"kind": "message", "content": 'héllo\n"world"'},
    }
    assert session_store.format_sse_heartbeat() == ": heartbeat\n\n"


def test_sse_stream_emits_activity_then_heartbeat(client: TestClient) -> None:
    project_id = _project(client)
    _activity(
        client,
        project_id,
        kind="worker_run",
        title="explore worker pi-1 started",
        status="running",
        actor="pi-1",
        run_id="run-sse",
        metadata={"task": "explore", "intent_description": "stream me"},
    )

    async def collect() -> list[str]:
        return [
            chunk
            async for chunk in session_store.stream_session_events(
                project_id,
                0,
                poll_seconds=0.01,
                heartbeat_seconds=0.02,
                max_seconds=0.12,
            )
        ]

    chunks = asyncio.run(collect())
    activity_frames = [chunk for chunk in chunks if "event: activity" in chunk]
    assert activity_frames, chunks
    decoded = [json.loads(frame.split("data: ", 1)[1]) for frame in activity_frames]
    worker_frames = [event for event in decoded if event["key"] == "worker:run-sse"]
    assert worker_frames, decoded
    assert all(frame.startswith("id: ") for frame in activity_frames)
    assert all(event["seq"] == event["activity"]["seq"] for event in decoded)
    assert any(chunk == ": heartbeat\n\n" for chunk in chunks)
