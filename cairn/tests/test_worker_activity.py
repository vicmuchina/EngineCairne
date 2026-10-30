from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cairn.dispatcher.config import DispatchConfig, LocalConfig
from cairn.dispatcher.runtime.cancellation import TaskCancellation
from cairn.dispatcher.runtime.local_backend import LocalBackend
from cairn.dispatcher.runtime.local_process import LocalProcess
from cairn.dispatcher.runtime.process import ManagedProcess, ProcessResult
from cairn.dispatcher.tasks import common, explore
from cairn.dispatcher.workers.activity import WorkerActivityRecorder
from cairn.dispatcher.workers.pi_events import PiWorkerEventParser
from cairn.server import db
from cairn.server.app import app

from conftest import FakeClient, make_intent, make_project


# ------------------------------------------------------------------ LocalProcess


def test_local_process_streams_lines_before_exit(tmp_path: Path) -> None:
    lines: list[str] = []
    first_line = threading.Event()
    script = (
        "import sys, time\n"
        "sys.stdout.write('first\\n')\n"
        "sys.stdout.flush()\n"
        "time.sleep(1.0)\n"
        "sys.stdout.write('second\\n')\n"
        "sys.stdout.flush()\n"
    )

    def on_line(line: str) -> None:
        lines.append(line)
        first_line.set()

    process = LocalProcess(
        [sys.executable, "-u", "-c", script],
        cwd=str(tmp_path),
        env=dict(os.environ),
        timeout_seconds=10,
        on_stdout_line=on_line,
    )
    process.start()
    assert first_line.wait(3.0), "first line was not delivered while the process was running"
    assert lines == ["first"]
    result = process.communicate(timeout=10)

    assert lines == ["first", "second"]
    assert result.stdout == "first\nsecond\n"
    assert result.returncode == 0


def test_local_process_reassembles_split_utf8_and_flushes_partial_line(tmp_path: Path) -> None:
    lines: list[str] = []
    # café and 😀 are split at arbitrary byte boundaries across separate writes; the
    # final record has no LF and must still be delivered at EOF.
    script = (
        "import os, time\n"
        "os.write(1, b'caf\\xc3')\n"
        "time.sleep(0.05)\n"
        "os.write(1, b'\\xa9 \\xf0\\x9f')\n"
        "time.sleep(0.05)\n"
        "os.write(1, b'\\x98\\x80\\ntail')\n"
    )
    process = LocalProcess(
        [sys.executable, "-u", "-c", script],
        cwd=str(tmp_path),
        env=dict(os.environ),
        timeout_seconds=10,
        on_stdout_line=lines.append,
    )
    process.start()
    result = process.communicate(timeout=10)

    assert lines == ["café 😀", "tail"]
    assert result.stdout == "café 😀\ntail"


def test_local_process_callback_failure_does_not_lose_stdout(tmp_path: Path) -> None:
    def boom(_line: str) -> None:
        raise RuntimeError("callback bug")

    process = LocalProcess(
        [sys.executable, "-c", "print('still captured')"],
        cwd=str(tmp_path),
        env=dict(os.environ),
        timeout_seconds=10,
        on_stdout_line=boom,
    )
    process.start()
    result = process.communicate(timeout=10)

    assert result.stdout == "still captured\n"
    assert result.returncode == 0


def test_local_process_final_stdout_keeps_universal_newlines(tmp_path: Path) -> None:
    lines: list[str] = []
    process = LocalProcess(
        [sys.executable, "-c", "import os; os.write(1, b'a\\r\\nb\\r')"],
        cwd=str(tmp_path),
        env=dict(os.environ),
        timeout_seconds=10,
        on_stdout_line=lines.append,
    )
    process.start()
    result = process.communicate(timeout=10)

    assert lines == ["a", "b"]
    # text=True used to translate CRLF/CR to LF; keep that contract for final capture.
    assert result.stdout == "a\nb\n"


class _FakeExecAPI:
    def __init__(self, chunks):
        self.chunks = chunks

    def exec_create(self, *_args, **_kwargs):
        return {"Id": "exec-1"}

    def exec_start(self, *_args, **_kwargs):
        return iter(self.chunks)

    def exec_inspect(self, *_args, **_kwargs):
        return {"Running": False, "ExitCode": 0}


class _FakeDockerClient:
    def __init__(self, api):
        self.api = api


class _FakeContainer:
    id = "container-1"
    name = "cairn-test"

    def __init__(self, api):
        self.client = _FakeDockerClient(api)


def test_managed_process_streams_split_utf8_stdout_lines() -> None:
    lines: list[str] = []
    api = _FakeExecAPI(
        [
            (b"caf\xc3", None),
            (b"\xa9\n", None),
            (None, b"stderr text"),
            (b"second\n", None),
        ]
    )
    process = ManagedProcess(_FakeContainer(api), ["pi"], {}, on_stdout_line=lines.append)
    process.start()
    result = process.communicate(timeout=5)

    assert lines == ["café", "second"]
    assert result.stdout == "café\nsecond\n"
    assert result.stderr == "stderr text"
    assert result.returncode == 0



# ---------------------------------------------------------------------- parser


def _jsonl(*events: dict) -> list[str]:
    return [json.dumps(event) for event in events]


def test_parser_maps_thinking_and_message_without_duplicates() -> None:
    parser = PiWorkerEventParser("pi-1")
    emissions = []
    for line in _jsonl(
        {"type": "session", "id": "sess-1"},
        {"type": "agent_start"},
        {"type": "turn_start"},
        {"type": "message_start", "message": {"role": "system", "content": "ignored"}},
        {"type": "message_end", "message": {"role": "system", "content": "ignored"}},
        {"type": "message_start", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
        {"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
        {"type": "message_start", "message": {"role": "assistant", "model": "deepseek-v4.1-flash"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "thinking_start", "contentIndex": 0}},
        {"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": "plan "}},
        {"type": "message_update", "assistantMessageEvent": {"type": "thinking_end", "contentIndex": 0, "content": "plan the tool"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_start", "contentIndex": 1}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 1, "delta": "done"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_end", "contentIndex": 1, "content": "done"}},
        {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}],
                                            "model": "deepseek-v4.1-flash", "stopReason": "stop"}},
    ):
        emissions.extend(parser.feed_line(line))

    assert parser.session == "sess-1"
    thinking = [e for e in emissions if e.kind == "worker_thinking"]
    assert thinking[0].status == "streaming"
    assert thinking[-1].status == "done"
    assert thinking[-1].description == "plan the tool"
    assert sum(1 for e in thinking if e.description == "plan the tool") <= 2

    messages = [e for e in emissions if e.kind == "worker_message"]
    assert messages[-1].description == "done"
    assert messages[-1].status == "done"
    assert messages[-1].metadata["stop_reason"] == "stop"
    # system/user messages are not worker transcript rows
    assert all((e.description or "") not in ("ignored", "hi") for e in messages)


def test_parser_pairs_tool_call_and_result_by_id() -> None:
    parser = PiWorkerEventParser("pi-1")
    emissions = []
    for line in _jsonl(
        {"type": "tool_execution_start", "toolCallId": "call_1", "toolName": "bash",
         "args": {"command": "echo hi"}},
        {"type": "tool_execution_update", "toolCallId": "call_1", "toolName": "bash",
         "partialResult": {"content": [{"type": "text", "text": "hi"}]}},
        {"type": "tool_execution_end", "toolCallId": "call_1", "toolName": "bash",
         "result": {"content": [{"type": "text", "text": "hi\n"}]},
         "isError": False, "durationMs": 7},
    ):
        emissions.extend(parser.feed_line(line))

    calls = [e for e in emissions if e.kind == "tool_call"]
    assert calls[0].status == "running"
    assert calls[-1].status == "done"
    assert calls[0].metadata["tool_name"] == "bash"
    assert json.loads(calls[0].description or "{}") == {"command": "echo hi"}

    results = [e for e in emissions if e.kind == "tool_result"]
    assert results[0].status == "running"
    assert results[-1].status == "done"
    assert results[-1].description == "hi\n"
    assert results[-1].metadata["tool_call_id"] == "call_1"
    assert results[-1].metadata["duration_ms"] == 7


def test_parser_errors_aborts_unknown_and_non_json() -> None:
    parser = PiWorkerEventParser("pi-1")
    emissions = []
    for line in [
        "not json at all",
        json.dumps({"type": "agent_start"}),
        json.dumps({"type": "some_future_event", "x": 1}),
        json.dumps({"type": "extension_error", "error": "extension exploded"}),
        json.dumps({"type": "message_start", "message": {"role": "assistant"}}),
        json.dumps({"type": "message_update", "assistantMessageEvent": {
            "type": "error", "error": {"errorMessage": "model failed"}}}),
        json.dumps({"type": "message_end", "message": {
            "role": "assistant", "content": [], "stopReason": "aborted"}}),
    ]:
        emissions.extend(parser.feed_line(line))

    assert [e.kind for e in emissions if e.kind == "worker_output"] == ["worker_output"]
    assert emissions[0].description == "not json at all"
    errors = [e for e in emissions if e.kind == "worker_error"]
    assert [e.description for e in errors] == ["extension exploded", "model failed"]
    # synthetic lifecycle/unknown events must not become transcript rows
    assert not any(e.kind in ("worker_thinking", "tool_call", "tool_result") for e in emissions)


def test_parser_bounds_large_tool_metadata() -> None:
    parser = PiWorkerEventParser("pi-1")
    big = "x" * 50_000
    emissions = []
    for line in _jsonl(
        {"type": "tool_execution_start", "toolCallId": "c1", "toolName": "bash",
         "args": {"command": big}},
        {"type": "tool_execution_end", "toolCallId": "c1", "toolName": "bash",
         "result": {"content": [{"type": "text", "text": big}]}, "isError": False},
    ):
        emissions.extend(parser.feed_line(line))
    call = next(e for e in emissions if e.kind == "tool_call")
    result = next(e for e in emissions if e.kind == "tool_result" and e.status == "done")
    # Metadata must stay valid JSON under the server's 20 k clip.
    assert len(json.dumps(call.metadata)) < 20_000
    assert len(json.dumps(result.metadata)) < 20_000
    assert len(result.metadata["tool_output"]) < 10_000


def test_parser_bounds_tool_error_metadata() -> None:
    parser = PiWorkerEventParser("pi-1")
    big = "y" * 50_000
    emissions = []
    for line in _jsonl(
        {"type": "tool_execution_start", "toolCallId": "c1", "toolName": "bash", "args": {}},
        {"type": "tool_execution_end", "toolCallId": "c1", "toolName": "bash",
         "result": {"content": [{"type": "text", "text": big}]}, "isError": True},
    ):
        emissions.extend(parser.feed_line(line))
    result = next(e for e in emissions if e.kind == "tool_result" and e.status == "error")
    assert len(json.dumps(result.metadata)) < 20_000
    assert result.metadata["is_error"] is True
    assert result.metadata["error"].startswith("y")


def test_parser_flush_keeps_streamed_partial_text() -> None:
    parser = PiWorkerEventParser("pi-1")
    emissions = []
    for line in _jsonl(
        {"type": "message_start", "message": {"role": "assistant"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_start", "contentIndex": 0}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "partial"}},
        {"type": "tool_execution_start", "toolCallId": "c1", "toolName": "bash", "args": {}},
        {"type": "tool_execution_update", "toolCallId": "c1", "toolName": "bash",
         "partialResult": {"content": [{"type": "text", "text": "running output"}]}},
    ):
        emissions.extend(parser.feed_line(line))
    emissions.extend(parser.flush())

    message = [e for e in emissions if e.kind == "worker_message"][-1]
    assert message.description == "partial"
    assert message.status == "streaming"
    result = [e for e in emissions if e.kind == "tool_result"][-1]
    assert result.description == "running output"


# --------------------------------------------------------------------- recorder


def test_recorder_start_and_finish_use_the_activity_writer() -> None:
    client = FakeClient(make_project())
    recorder = WorkerActivityRecorder(
        client,
        project_id="proj_001",
        worker="pi-1",
        task="explore",
        intent_id="i001",
        intent_description="investigate",
    )
    recorder.start()
    for line in _jsonl(
        {"type": "message_start", "message": {"role": "assistant"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "hi"}},
        {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}],
                                            "stopReason": "stop"}},
        {"type": "tool_execution_start", "toolCallId": "c1", "toolName": "read", "args": {"path": "x"}},
        {"type": "tool_execution_end", "toolCallId": "c1", "toolName": "read",
         "result": {"content": [{"type": "text", "text": "body"}]}, "isError": False},
    ):
        recorder.feed_line(line)
    recorder.finish(result=ProcessResult(0, "", ""), session="sess-1")

    starts = [a for a in client.activities if a.get("kind") == "worker_run"]
    assert len(starts) == 1
    assert starts[0]["run_id"] == recorder.run_id
    assert starts[0]["actor"] == "pi-1"
    assert starts[0]["metadata"]["intent_id"] == "i001"
    closes = [a for a in client.activities if a.get("kind") == "close"]
    assert len(closes) == 1
    assert closes[0]["status"] == "success"
    assert closes[0]["metadata"]["session"] == "sess-1"
    assert closes[0]["metadata"]["intent_id"] == "i001"
    kinds = {a.get("kind") for a in client.activities}
    assert {"worker_message", "tool_call", "tool_result"} <= kinds
    assert any(a.get("kind") == "update" for a in client.activities)


def test_recorder_maps_failure_and_timeout_to_terminal_status() -> None:
    client = FakeClient(make_project())
    failed = WorkerActivityRecorder(client, project_id="proj_001", worker="pi-1", task="reason")
    failed.start()
    failed.finish(result=ProcessResult(2, "", "boom"))
    close = next(a for a in client.activities if a.get("kind") == "close")
    assert close["status"] == "failed"
    assert close["error"] == "boom"

    timeout_client = FakeClient(make_project())
    timed_out = WorkerActivityRecorder(
        timeout_client, project_id="proj_001", worker="pi-1", task="reason"
    )
    timed_out.start()
    timed_out.finish(result=ProcessResult(124, "", "", timed_out=True))
    timeout_close = next(a for a in timeout_client.activities if a.get("kind") == "close")
    assert timeout_close["status"] == "timeout"
    assert timeout_close["error"] == "worker timed out"


def test_recorder_emits_no_transcript_for_an_empty_pi_run() -> None:
    client = FakeClient(make_project())
    recorder = WorkerActivityRecorder(
        client, project_id="proj_001", worker="pi-1", task="reason"
    )
    recorder.start()
    for line in _jsonl({"type": "session", "id": "s"}, {"type": "agent_start"},
                       {"type": "turn_start"}, {"type": "agent_end", "messages": []}):
        recorder.feed_line(line)
    recorder.finish(result=ProcessResult(0, "", ""))

    assert [a["kind"] for a in client.activities if a.get("kind") != "close"] == ["worker_run"]
    assert [a for a in client.activities if a.get("kind") == "close"][0]["status"] == "success"


# ----------------------------------------------------------------------- server


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "cairn.db")
    with TestClient(app) as test_client:
        yield test_client


def _project(client: TestClient) -> str:
    response = client.post(
        "/projects", json={"title": "worker-test", "origin": "start", "goal": "finish"}
    )
    assert response.status_code == 201, response.text
    return response.json()["project"]["id"]


def _activity(client: TestClient, project_id: str, **payload) -> dict:
    response = client.post(f"/projects/{project_id}/activity", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _seed_run(client: TestClient, project_id: str, run_id: str = "run-1") -> None:
    _activity(
        client, project_id,
        kind="worker_run", title="explore worker pi-1 started", status="running",
        actor="pi-1", run_id=run_id,
        metadata={"task": "explore", "intent_id": "i001", "intent_description": "investigate",
                  "started_at": "2026-10-30T00:00:00Z"},
    )
    _activity(
        client, project_id,
        kind="worker_thinking", title="worker pi-1 thinking", status="streaming",
        actor="pi-1", run_id=run_id, description="half a thought",
        metadata={"content_index": 0},
    )
    _activity(
        client, project_id,
        kind="tool_call", title="Tool bash", status="running", actor="pi-1", run_id=run_id,
        description='{"command": "echo hi"}',
        metadata={"tool_name": "bash", "tool_call_id": "c1"},
    )
    _activity(
        client, project_id,
        kind="tool_result", title="Tool bash result", status="done", actor="pi-1", run_id=run_id,
        description="hi\n", metadata={"tool_name": "bash", "tool_call_id": "c1"},
    )
    _activity(
        client, project_id,
        kind="worker_message", title="worker pi-1 message", status="done", actor="pi-1",
        run_id=run_id, description="all done", metadata={"stop_reason": "stop"},
    )


def test_worker_endpoint_returns_active_run_and_ordered_transcript(client: TestClient) -> None:
    project_id = _project(client)
    empty = client.get(f"/projects/{project_id}/workers").json()
    assert empty["items"] == [] and empty["active_count"] == 0
    assert client.get("/projects/missing/workers").status_code == 404
    _seed_run(client, project_id)

    response = client.get(f"/projects/{project_id}/workers")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["project_id"] == project_id
    assert payload["active_count"] == 1
    run = payload["items"][0]
    assert run["run_id"] == "run-1"
    assert run["worker"] == "pi-1"
    assert run["task"] == "explore"
    assert run["intent_id"] == "i001"
    assert run["intent_description"] == "investigate"
    assert run["status"] == "running"
    assert run["active"] is True and run["stale"] is False
    assert run["started_at"] == "2026-10-30T00:00:00Z"
    assert run["finished_at"] is None
    assert [step["kind"] for step in run["transcript"]] == [
        "worker_thinking", "tool_call", "tool_result", "worker_message"
    ]
    assert all(step["run_id"] == "run-1" for step in run["transcript"])
    assert run["counts"] == {
        "activities": 4, "thinking": 1, "tool_calls": 1, "tool_results": 1,
        "messages": 1, "errors": 0,
    }

    # Filtering and detail agree.
    active = client.get(f"/projects/{project_id}/workers", params={"active_only": "true"}).json()
    assert [item["run_id"] for item in active["items"]] == ["run-1"]
    assert [item["run_id"] for item in client.get(
        f"/projects/{project_id}/workers", params={"worker": "pi-1"}
    ).json()["items"]] == ["run-1"]
    assert client.get(
        f"/projects/{project_id}/workers", params={"worker": "someone-else"}
    ).json()["items"] == []
    truncated = client.get(
        f"/projects/{project_id}/workers", params={"transcript_limit": 1}
    ).json()["items"][0]
    assert truncated["transcript_truncated"] is True
    assert len(truncated["transcript"]) == 1
    detail = client.get(f"/projects/{project_id}/workers/runs/run-1")
    assert detail.status_code == 200
    assert detail.json()["run_id"] == "run-1"
    assert client.get(f"/projects/{project_id}/workers/runs/missing").status_code == 404


def test_worker_patch_updates_only_transcript_rows(client: TestClient) -> None:
    project_id = _project(client)
    _seed_run(client, project_id)
    thinking = next(
        item for item in client.get(f"/projects/{project_id}/workers").json()["items"][0]["transcript"]
        if item["kind"] == "worker_thinking"
    )
    activity_id = thinking["metadata"]["activity_id"]

    response = client.patch(
        f"/projects/{project_id}/workers/activity/{activity_id}",
        json={"status": "done", "description": "the whole thought", "metadata": {"tokens": 7}},
    )
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["status"] == "done"
    assert updated["description"] == "the whole thought"
    assert updated["metadata"]["tokens"] == 7
    assert updated["metadata"]["run_id"] == "run-1"

    # A normal project activity is not editable through the worker surface.
    project_event = _activity(client, project_id, kind="project", title="Project created")
    non_worker_id = project_event["metadata"].get("activity_id") or int(project_event["id"].split(":")[1])
    assert client.patch(
        f"/projects/{project_id}/workers/activity/{non_worker_id}", json={"status": "done"}
    ).status_code == 409
    assert client.patch(
        f"/projects/{project_id}/workers/activity/99999", json={"status": "done"}
    ).status_code == 404
    assert client.patch(
        f"/projects/{project_id}/workers/activity/{activity_id}", json={}
    ).status_code == 400


def test_worker_close_is_idempotent_and_leaves_no_open_rows(client: TestClient) -> None:
    project_id = _project(client)
    _seed_run(client, project_id)

    first = client.post(
        f"/projects/{project_id}/workers/runs/run-1/close",
        json={"status": "success", "metadata": {"duration_ms": 1234}},
    )
    assert first.status_code == 200, first.text
    run = first.json()
    assert run["status"] == "success"
    assert run["active"] is False
    assert run["finished_at"] is not None
    assert run["duration_ms"] == 1234

    second = client.post(
        f"/projects/{project_id}/workers/runs/run-1/close", json={"status": "success"}
    )
    assert second.status_code == 200
    no_body = client.post(f"/projects/{project_id}/workers/runs/run-1/close")
    assert no_body.status_code == 200
    assert no_body.json()["status"] == "success"
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT kind, status FROM project_activity WHERE project_id = ? AND run_id = ?",
            (project_id, "run-1"),
        ).fetchall()
    assert [row["kind"] for row in rows].count("worker_run") == 2
    assert not [row for row in rows if row["status"] in ("running", "streaming")]
    assert client.get(f"/projects/{project_id}/workers", params={"active_only": "true"}).json()[
        "items"
    ] == []


def test_worker_close_cancelled_marks_open_tool_rows_cancelled(client: TestClient) -> None:
    project_id = _project(client)
    _seed_run(client, project_id)

    response = client.post(
        f"/projects/{project_id}/workers/runs/run-1/close",
        json={"status": "cancelled", "error": "project stopped"},
    )
    assert response.status_code == 200, response.text
    run = response.json()
    assert run["status"] == "cancelled"
    assert run["error"] == "project stopped"
    with db.get_conn() as conn:
        statuses = {
            row["status"]
            for row in conn.execute(
                "SELECT status FROM project_activity WHERE project_id = ? AND run_id = ?",
                (project_id, "run-1"),
            ).fetchall()
        }
    assert "running" not in statuses and "streaming" not in statuses
    assert "cancelled" in statuses


def test_worker_run_goes_stale_without_finishing(client: TestClient) -> None:
    project_id = _project(client)
    _seed_run(client, project_id)
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE project_activity SET created_at = '2020-01-01T00:00:00Z' "
            "WHERE project_id = ? AND run_id = ?",
            (project_id, "run-1"),
        )

    run = client.get(f"/projects/{project_id}/workers").json()["items"][0]
    assert run["active"] is False
    assert run["stale"] is True
    assert run["status"] == "running"
    assert client.get(f"/projects/{project_id}/workers", params={"active_only": "true"}).json()[
        "items"
    ] == []


def test_activity_feed_includes_worker_kinds_and_keeps_run_id(client: TestClient) -> None:
    project_id = _project(client)
    _seed_run(client, project_id)

    feed = client.get(
        f"/projects/{project_id}/activity",
        params={"kinds": "worker_run,worker_thinking,tool_call,tool_result,worker_message"},
    )
    assert feed.status_code == 200, feed.text
    items = feed.json()["items"]
    assert [item["kind"] for item in items] == [
        "worker_run", "worker_thinking", "tool_call", "tool_result", "worker_message"
    ]
    assert all(item["run_id"] == "run-1" for item in items)
    # Default feed still carries them and stays paginatable.
    default = client.get(f"/projects/{project_id}/activity").json()
    assert any(item["kind"] == "worker_message" for item in default["items"])
    assert default["next_cursor"]


# ------------------------------------------------------------ dispatcher end-to-end


def _local_config(timeout: int = 10) -> DispatchConfig:
    return DispatchConfig.model_validate(
        {
            "server": "in-process",
            "runtime": {
                "execution": "local",
                "worker_healthcheck": "disabled",
                "interval": 60,
                "max_workers": 1,
                "max_running_projects": 1,
                "max_project_workers": 1,
                "healthcheck_timeout": 5,
                "prompt_group": "default",
            },
            "tasks": {
                "bootstrap": {"timeout": timeout, "conclude_timeout": timeout},
                "reason": {"timeout": timeout, "max_intents": 3},
                "explore": {"timeout": timeout, "conclude_timeout": timeout},
            },
            "workers": [
                {"name": "pi-1", "type": "pi", "task_types": ["explore"],
                 "max_running": 1, "priority": 0}
            ],
        }
    )


def _install_fake_pi(tmp_path: Path, monkeypatch, events: list[dict], *, sleep: float = 0.0) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    script = bin_dir / "pi"
    body = (
        f"#!{sys.executable}\n"
        "import json, time\n"
        f"EVENTS = {events!r}\n"
        "for event in EVENTS:\n"
        "    print(json.dumps(event), flush=True)\n"
        f"time.sleep({sleep!r})\n"
    )
    script.write_text(body)
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")


def _full_worker_events() -> list[dict]:
    final = '{"accepted":true,"data":{"description":"worker traced fact"}}'
    return [
        {"type": "session", "id": "sess-1"},
        {"type": "agent_start"},
        {"type": "turn_start"},
        {"type": "message_start", "message": {"role": "assistant", "content": []}},
        {"type": "message_update", "assistantMessageEvent": {"type": "thinking_start", "contentIndex": 0}},
        {"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": "plan"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "thinking_end", "contentIndex": 0, "content": "plan"}},
        {"type": "tool_execution_start", "toolCallId": "call_1", "toolName": "bash",
         "args": {"command": "echo CAIRN_WORKER_TRACE_OK"}},
        {"type": "tool_execution_update", "toolCallId": "call_1", "toolName": "bash",
         "partialResult": {"content": [{"type": "text", "text": "CAIRN_WORKER_TRACE_OK\n"}]}},
        {"type": "tool_execution_end", "toolCallId": "call_1", "toolName": "bash",
         "result": {"content": [{"type": "text", "text": "CAIRN_WORKER_TRACE_OK\n"}]},
         "isError": False, "durationMs": 4},
        {"type": "message_end", "message": {"role": "assistant",
                                            "content": [{"type": "toolCall", "id": "call_1",
                                                         "name": "bash", "arguments": {"command": "echo"}}],
                                            "stopReason": "toolUse"}},
        {"type": "turn_start"},
        {"type": "message_start", "message": {"role": "assistant", "content": []}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_start", "contentIndex": 0}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": final}},
        {"type": "message_end", "message": {"role": "assistant",
                                            "content": [{"type": "text", "text": final}],
                                            "stopReason": "stop"}},
        {"type": "turn_end", "message": {"role": "assistant",
                                         "content": [{"type": "text", "text": final}]},
         "toolResults": []},
        {"type": "agent_end", "messages": [], "willRetry": False},
    ]


def _run_explore(tmp_path: Path, monkeypatch, events: list[dict], *, timeout: int = 10,
                 sleep: float = 0.0, cancellation: TaskCancellation | None = None):
    _install_fake_pi(tmp_path, monkeypatch, events, sleep=sleep)
    monkeypatch.setattr(common, "GRAPH_SNAPSHOT_ROOT", str(tmp_path / "prompts"))
    config = _local_config(timeout=timeout)
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path / "work")))
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)
    result: dict = {}

    try:
        result["outcome"] = explore.run_explore_task(
            config, client, backend, project, "facts:\n- id: f001\n",
            intent, config.workers[0], cancellation or TaskCancellation(),
        )
    except BaseException as exc:  # pragma: no cover - surfaced by the assertion below
        result["error"] = exc
    return result, client


def test_explore_records_the_real_pi_event_stream(tmp_path: Path, monkeypatch) -> None:
    result, client = _run_explore(tmp_path, monkeypatch, _full_worker_events())

    assert "error" not in result, result.get("error")
    assert result["outcome"] == "success"
    assert client.concluded == [("proj_001", "i001", "pi-1", "worker traced fact")]

    activities = client.activities
    start = next(a for a in activities if a.get("kind") == "worker_run")
    assert start["run_id"]
    assert start["metadata"]["intent_id"] == "i001"
    assert start["metadata"]["intent_description"] == "investigate"
    close = next(a for a in activities if a.get("kind") == "close")
    assert close["status"] == "success"
    assert close["metadata"]["duration_ms"] >= 0
    assert close["metadata"]["session"] == "sess-1"

    tool_calls = [a for a in activities if a.get("kind") == "tool_call"]
    assert tool_calls[0]["metadata"]["tool_name"] == "bash"
    assert "CAIRN_WORKER_TRACE_OK" in (tool_calls[0]["description"] or "")
    results = [a for a in activities if a.get("kind") == "tool_result" and a.get("status") == "done"]
    assert results[-1]["description"] == "CAIRN_WORKER_TRACE_OK\n"
    messages = [a for a in activities if a.get("kind") == "worker_message" and a.get("status") == "done"]
    assert messages[-1]["description"] == '{"accepted":true,"data":{"description":"worker traced fact"}}'
    assert any(a.get("kind") == "worker_thinking" for a in activities)


def test_explore_cancel_closes_the_run_as_cancelled(tmp_path: Path, monkeypatch) -> None:
    cancellation = TaskCancellation()
    events = [
        {"type": "session", "id": "sess-cancel"},
        {"type": "agent_start"},
        {"type": "turn_start"},
        {"type": "message_start", "message": {"role": "assistant", "content": []}},
        {"type": "tool_execution_start", "toolCallId": "call_slow", "toolName": "bash",
         "args": {"command": "sleep 100"}},
    ]
    _install_fake_pi(tmp_path, monkeypatch, events, sleep=30)
    monkeypatch.setattr(common, "GRAPH_SNAPSHOT_ROOT", str(tmp_path / "prompts"))
    config = _local_config(timeout=30)
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path / "work")))
    intent = make_intent()
    project = make_project(intents=[intent])
    client = FakeClient(project)
    result: dict = {}

    def run() -> None:
        try:
            result["outcome"] = explore.run_explore_task(
                config, client, backend, project, "facts:\n- id: f001\n",
                intent, config.workers[0], cancellation,
            )
        except BaseException as exc:  # pragma: no cover
            result["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if any(a.get("kind") == "tool_call" for a in client.activities):
            break
        time.sleep(0.05)
    cancellation.cancel("project stopped")
    thread.join(20)

    assert not thread.is_alive()
    assert "error" not in result, result.get("error")
    assert result["outcome"] == "cancelled"
    close = next(a for a in client.activities if a.get("kind") == "close")
    assert close["status"] == "cancelled"
    assert close["metadata"]["cancel_reason"] == "project stopped"
    assert client.released == [("proj_001", "i001", "pi-1")]


def test_explore_timeout_closes_the_run_as_timeout(tmp_path: Path, monkeypatch) -> None:
    events = [
        {"type": "session", "id": "sess-timeout"},
        {"type": "agent_start"},
        {"type": "tool_execution_start", "toolCallId": "call_slow", "toolName": "bash",
         "args": {"command": "sleep 100"}},
    ]
    result, client = _run_explore(tmp_path, monkeypatch, events, timeout=1, sleep=30)

    assert "error" not in result, result.get("error")
    assert result["outcome"] == "failed"
    close = next(a for a in client.activities if a.get("kind") == "close")
    assert close["status"] == "timeout"
