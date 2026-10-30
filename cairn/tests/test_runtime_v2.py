from __future__ import annotations

"""Runtime v2 tests: rich pi events, activities, project feed, steering, approvals, MCP."""

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from cairn.control.client import ControlClient, ControlError, run_action
from cairn.control import mcp_server
from cairn.server import activity as activity_store
from cairn.server import db, pi_rpc
from cairn.server.app import app


PI_STUB = r'''
import json
import os
import sys
import time

mode = os.environ.get("CAIRN_TEST_PI_MODE", "rich")
text = os.environ.get("CAIRN_TEST_PI_TEXT", "CAIRN_CHAT_OK")

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

usage1 = {"input": 100, "output": 5, "cacheRead": 0, "cacheWrite": 0,
          "totalTokens": 105, "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0,
                                       "cacheWrite": 0.0, "total": 0.0}}
usage2 = {"input": 150, "output": 7, "cacheRead": 10, "cacheWrite": 0,
          "totalTokens": 167, "cost": {"input": 0.0, "output": 0.0, "cacheRead": 0.0,
                                       "cacheWrite": 0.0, "total": 0.0}}
user_message = {"role": "user", "content": [{"type": "text", "text": "hi"}], "timestamp": 1}
assistant1 = {"role": "assistant", "content": [
        {"type": "text", "text": "Let me check."},
        {"type": "toolCall", "id": "call_1", "name": "read", "arguments": {"path": "x"}},
    ], "api": "test", "provider": "test", "model": "test-model",
    "usage": usage1, "stopReason": "toolUse", "timestamp": 2}
assistant2 = {"role": "assistant", "content": [{"type": "text", "text": text}],
    "api": "test", "provider": "test", "model": "test-model",
    "usage": usage2, "stopReason": "stop", "timestamp": 3}

if mode == "rich":
    emit({"type": "session", "id": "sess-1", "timestamp": 1, "cwd": os.getcwd(),
          "version": "1.4.0"})
    emit({"type": "agent_start"})
    emit({"type": "turn_start"})
    emit({"type": "message_start", "message": user_message})
    emit({"type": "message_end", "message": user_message})
    emit({"type": "message_start", "message": assistant1})
    emit({"type": "message_update", "usage": usage1,
          "assistantMessageEvent": {"type": "text_start", "contentIndex": 0}})
    emit({"type": "message_update", "usage": usage1,
          "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "Let me "}})
    emit({"type": "message_update", "usage": usage1,
          "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "check."}})
    emit({"type": "message_update", "usage": usage1,
          "assistantMessageEvent": {"type": "toolcall_end", "contentIndex": 1,
                                    "toolCall": {"type": "toolCall", "id": "call_1",
                                                 "name": "read", "arguments": {"path": "x"}}}})
    emit({"type": "tool_execution_start", "toolCallId": "call_1", "toolName": "read",
          "args": {"path": "x"}})
    emit({"type": "tool_execution_end", "toolCallId": "call_1", "toolName": "read",
          "result": {"content": [{"type": "text", "text": "file body"}], "isError": False},
          "isError": False, "durationMs": 12})
    emit({"type": "tool_execution_start", "toolCallId": "call_blocked", "toolName": "bash",
          "args": {"command": "touch /tmp/should-not-exist"}})
    emit({"type": "tool_execution_end", "toolCallId": "call_blocked", "toolName": "bash",
          "result": {"content": [{"type": "text",
                    "text": "Tool call \"bash\" was not approved: approval #7 is pending."}],
                    "isError": True},
          "isError": True, "durationMs": 1})
    emit({"type": "message_end", "message": assistant1})
    emit({"type": "turn_end", "message": assistant1, "toolResults": []})
    emit({"type": "turn_start"})
    emit({"type": "message_start", "message": assistant2})
    emit({"type": "message_update", "usage": usage2,
          "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": text}})
    emit({"type": "message_end", "message": assistant2})
    emit({"type": "turn_end", "message": assistant2, "toolResults": []})
    emit({"type": "agent_end", "messages": [user_message, assistant1, assistant2],
          "willRetry": False})
elif mode in ("stopmid", "timeoutmid"):
    emit({"type": "session", "id": "sess-1", "timestamp": 1, "cwd": os.getcwd()})
    emit({"type": "agent_start"})
    emit({"type": "turn_start"})
    emit({"type": "message_start", "message": assistant1})
    emit({"type": "tool_execution_start", "toolCallId": "call_slow", "toolName": "bash",
          "args": {"command": "sleep 100"}})
    emit({"type": "message_update", "usage": usage1,
          "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0,
                                    "delta": "thinking hard"}})
    time.sleep(float(os.environ.get("CAIRN_TEST_PI_SLEEP", "30")))
elif mode == "empty":
    sys.exit(0)
elif mode == "fail":
    sys.stderr.write("stub failure\n")
    sys.exit(3)
'''


class Env:
    def __init__(self, tmp_path: Path, stub: Path):
        self.tmp_path = tmp_path
        self.stub = stub
        self.root = tmp_path / "cairnroot"


@pytest.fixture
def runtime_env(tmp_path, monkeypatch) -> Env:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "cairn.db")
    root = tmp_path / "cairnroot"
    stub = tmp_path / "fake_pi.py"
    stub.write_text(f"#!{sys.executable}\n" + PI_STUB, encoding="utf-8")
    stub.chmod(0o755)
    monkeypatch.setenv("CAIRN_CHAT_ROOT", str(root))
    monkeypatch.setenv("CAIRN_CHAT_PI_BIN", str(stub))
    monkeypatch.setenv("CAIRN_TEST_PI_MODE", "rich")
    monkeypatch.setenv("CAIRN_CHAT_TOOLS", "none")
    monkeypatch.delenv("CAIRN_CHAT_TIMEOUT", raising=False)
    monkeypatch.delenv("CAIRN_CHAT_CONTROL", raising=False)
    monkeypatch.delenv("CAIRN_CHAT_APPROVAL_TOOLS", raising=False)
    # v2 ingestion tests drive the one-shot json path with a JSONL stub.
    monkeypatch.setenv("CAIRN_CHAT_RPC", "0")
    pi_rpc.reset_manager()
    return Env(tmp_path, stub)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


async def _create_project(client: httpx.AsyncClient, title: str = "runtime-v2") -> str:
    response = await client.post(
        "/projects",
        json={"title": title, "origin": "start", "goal": "reach the goal"},
    )
    assert response.status_code == 201, response.text
    return response.json()["project"]["id"]


async def _conversation(client: httpx.AsyncClient, project_id: str) -> int:
    response = await client.post("/chat/conversations", json={"project_id": project_id})
    assert response.status_code == 201, response.text
    return response.json()["id"]


# --------------------------------------------------------------- rich ingestion


async def _scenario_rich_events(runtime_env: Env) -> None:
    async with _client() as client:
        project_id = await _create_project(client)
        conversation_id = await _conversation(client, project_id)

        response = await client.post(
            f"/chat/conversations/{conversation_id}/messages",
            json={"message": "hi"},
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assistant = payload["items"][1]
        assert assistant["content"] == "CAIRN_CHAT_OK"
        assert assistant["status"] == "done"
        assert assistant["tokens_in"] == 250
        assert assistant["tokens_out"] == 12
        assert payload["conversation"]["tokens_in"] == 250
        assert payload["conversation"]["tokens_out"] == 12
        assert payload["conversation"]["activity_count"] > 0

        activities = (
            await client.get(f"/chat/conversations/{conversation_id}/activities")
        ).json()
        items = activities["items"]
        kinds = [item["kind"] for item in items]
        assert kinds[0] == "session"
        assert "agent_start" in kinds
        assert kinds.count("turn_start") == 2
        assert kinds.count("turn_end") == 2
        assert kinds.count("usage") == 2
        assert kinds[-1] == "agent_end"
        # seq is monotonic and gapless enough to poll with after_seq
        assert [item["seq"] for item in items] == sorted(item["seq"] for item in items)
        assert len({item["seq"] for item in items}) == len(items)

        tools = [item for item in items if item["kind"] == "tool_call"]
        assert [tool["tool_name"] for tool in tools] == ["read", "bash"]
        assert [tool["status"] for tool in tools] == ["done", "error"]
        assert "was not approved" in (tools[1]["error"] or "")
        tool = tools[0]
        assert tool["tool_name"] == "read"
        assert tool["status"] == "done"
        assert json.loads(tool["tool_input"]) == {"path": "x"}
        assert tool["tool_output"] == "file body"
        assert tool["tool_call_id"] == "call_1"
        assert tool["message_id"] == assistant["id"]

        assistant_messages = [
            item for item in items if item["kind"] == "message" and item["role"] == "assistant"
        ]
        assert [item["status"] for item in assistant_messages] == ["done", "done"]
        assert assistant_messages[-1]["content"] == "CAIRN_CHAT_OK"

        usage = [item for item in items if item["kind"] == "usage"]
        assert [(item["tokens_in"], item["tokens_out"]) for item in usage] == [(100, 5), (150, 7)]

        with db.get_conn() as conn:
            run = conn.execute(
                "SELECT * FROM chat_runs WHERE conversation_id = ?", (conversation_id,)
            ).fetchone()
            assert run["tokens_in"] == 250
            assert run["tokens_out"] == 12
            assert run["turns"] == 2
            assert run["tool_calls"] == 2
            assert run["model"] == "test-model"

        # Polling with after_seq returns only newer rows.
        last_seq = items[-1]["seq"]
        tail = (
            await client.get(
                f"/chat/conversations/{conversation_id}/activities",
                params={"after_seq": last_seq},
            )
        ).json()
        assert tail["items"] == []
        assert tail["next_after_seq"] == last_seq
        first_page = (
            await client.get(
                f"/chat/conversations/{conversation_id}/activities",
                params={"limit": 3},
            )
        ).json()
        assert len(first_page["items"]) == 3
        assert first_page["has_more"] is True
        assert first_page["next_after_seq"] == first_page["items"][-1]["seq"]
        second_page = (
            await client.get(
                f"/chat/conversations/{conversation_id}/activities",
                params={"after_seq": first_page["next_after_seq"], "limit": 3},
            )
        ).json()
        assert second_page["items"][0]["seq"] > first_page["next_after_seq"]

        # kind filter
        only_tools = (
            await client.get(
                f"/chat/conversations/{conversation_id}/activities",
                params={"kind": "tool_call"},
            )
        ).json()["items"]
        assert [item["kind"] for item in only_tools] == ["tool_call", "tool_call"]


def test_rich_pi_events_are_persisted(runtime_env: Env) -> None:
    asyncio.run(_scenario_rich_events(runtime_env))


async def _scenario_stop_marks_trace(runtime_env: Env, monkeypatch) -> None:
    async with _client() as client:
        project_id = await _create_project(client)
        conversation_id = await _conversation(client, project_id)
        monkeypatch.setenv("CAIRN_TEST_PI_MODE", "stopmid")
        monkeypatch.setenv("CAIRN_TEST_PI_SLEEP", "30")

        turn = asyncio.create_task(
            client.post(
                f"/chat/conversations/{conversation_id}/messages",
                json={"message": "slow one"},
            )
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with db.get_conn() as conn:
                running = conn.execute(
                    "SELECT COUNT(*) FROM chat_activities WHERE conversation_id = ? "
                    "AND kind = 'tool_call' AND status = 'running'",
                    (conversation_id,),
                ).fetchone()[0]
            if running:
                break
            await asyncio.sleep(0.05)
        assert running == 1, "tool_call activity was not persisted while the turn was live"

        stop = await client.post(f"/chat/conversations/{conversation_id}/stop")
        assert stop.status_code == 200, stop.text
        assert stop.json()["stopped"] is True

        result = await asyncio.wait_for(turn, timeout=20)
        assert result.status_code == 200, result.text
        assert result.json()["items"][1]["status"] == "stopped"

        items = (
            await client.get(f"/chat/conversations/{conversation_id}/activities")
        ).json()["items"]
        tool = next(item for item in items if item["kind"] == "tool_call")
        assert tool["status"] == "stopped"
        assert tool["tool_name"] == "bash"
        message = next(
            item for item in items if item["kind"] == "message" and item["role"] == "assistant"
        )
        assert message["status"] == "stopped"


def test_stop_marks_activities(runtime_env: Env, monkeypatch) -> None:
    asyncio.run(_scenario_stop_marks_trace(runtime_env, monkeypatch))


async def _scenario_timeout_marks_trace(runtime_env: Env, monkeypatch) -> None:
    async with _client() as client:
        project_id = await _create_project(client)
        conversation_id = await _conversation(client, project_id)
        monkeypatch.setenv("CAIRN_TEST_PI_MODE", "timeoutmid")
        monkeypatch.setenv("CAIRN_TEST_PI_SLEEP", "30")
        monkeypatch.setenv("CAIRN_CHAT_TIMEOUT", "0.4")

        response = await client.post(
            f"/chat/conversations/{conversation_id}/messages",
            json={"message": "timeout"},
        )
        assert response.status_code == 200, response.text
        assistant = response.json()["items"][1]
        assert assistant["status"] == "error"
        assert "timed out" in assistant["error"]

        items = (
            await client.get(f"/chat/conversations/{conversation_id}/activities")
        ).json()["items"]
        tool = next(item for item in items if item["kind"] == "tool_call")
        assert tool["status"] == "error"
        assert "timed out" in (tool["error"] or "")
        with db.get_conn() as conn:
            run = conn.execute(
                "SELECT * FROM chat_runs WHERE conversation_id = ?", (conversation_id,)
            ).fetchone()
            assert run["status"] == "error"


def test_timeout_marks_activities(runtime_env: Env, monkeypatch) -> None:
    asyncio.run(_scenario_timeout_marks_trace(runtime_env, monkeypatch))


# ------------------------------------------------------------- project feed


async def _scenario_project_feed(runtime_env: Env) -> None:
    async with _client() as client:
        project_id = await _create_project(client)
        conversation_id = await _conversation(client, project_id)

        intent = await client.post(
            f"/projects/{project_id}/intents",
            json={"from": ["origin"], "description": "first direction", "creator": "reasoner"},
        )
        assert intent.status_code == 201, intent.text
        assert intent.json()["priority"] == 0
        await client.post(
            f"/projects/{project_id}/intents/i001/heartbeat", json={"worker": "explorer"}
        )
        concluded = await client.post(
            f"/projects/{project_id}/intents/i001/conclude",
            json={"worker": "explorer", "description": "found something"},
        )
        assert concluded.status_code == 200, concluded.text
        await client.post(
            f"/projects/{project_id}/hints",
            json={"content": "look at the cache", "creator": "human"},
        )
        await client.post(
            f"/chat/conversations/{conversation_id}/messages", json={"message": "hi"}
        )

        feed = (await client.get(f"/projects/{project_id}/activity", params={"limit": 100})).json()
        items = feed["items"]
        by_kind = {}
        for item in items:
            by_kind.setdefault(item["kind"], []).append(item)

        assert {item["id"] for item in by_kind["goal"]} == {"fact:goal"}
        fact_ids = {item["id"] for item in by_kind["fact"]}
        assert fact_ids == {"fact:origin", "fact:f001"}
        # Derive-then-claim: the intent itself is derived from the intents table, and the
        # claim is an activity row (claim history is not stored on the intent row).
        intents = [item for item in by_kind["intent"] if item["id"].startswith("intent:")]
        assert len(intents) == 1
        assert intents[0]["status"] == "concluded"
        claims = [item for item in by_kind["intent"] if item["id"].startswith("event:")]
        assert [item["status"] for item in claims] == ["working"]
        assert claims[0]["actor"] == "explorer"
        assert len(by_kind["hint"]) == 1
        assert len(by_kind.get("tool", [])) == 2
        chat_items = by_kind.get("chat", [])
        assert [item["metadata"]["message_id"] for item in chat_items]
        assert all(item["source"] == "chat" for item in chat_items)
        assert by_kind["tool"][0]["metadata"]["tool_name"] == "read"

        origin = next(item for item in items if item["id"] == "fact:origin")
        assert origin["timestamp"] is None
        assert origin["timestamp_source"] == "unknown"
        produced = next(item for item in items if item["id"] == "fact:f001")
        assert produced["timestamp"] == concluded.json()["intent"]["concluded_at"]
        assert produced["timestamp_source"] == "intent.concluded_at"

        # Chronological ordering (unknown timestamps last)
        known = [item["timestamp"] for item in items if item["timestamp"]]
        assert known == sorted(known)
        assert items[-1]["timestamp"] is None

        # Cursor pagination: no duplicates, no gaps for known-timestamp events.
        page1 = (
            await client.get(f"/projects/{project_id}/activity", params={"limit": 3})
        ).json()
        assert len(page1["items"]) == 3
        assert page1["has_more"] is True
        page2 = (
            await client.get(
                f"/projects/{project_id}/activity",
                params={"limit": 100, "after": page1["next_cursor"]},
            )
        ).json()
        ids1 = [item["id"] for item in page1["items"]]
        ids2 = [item["id"] for item in page2["items"]]
        assert set(ids1).isdisjoint(ids2)

        # kind filter
        only_intents = (
            await client.get(
                f"/projects/{project_id}/activity", params={"kinds": "intent"}
            )
        ).json()["items"]
        assert [item["kind"] for item in only_intents] == ["intent", "intent"]

        overview = (await client.get(f"/projects/{project_id}/overview")).json()
        counts = overview["counts"]
        assert counts["facts"] == 3
        assert counts["intents"] == 1
        assert counts["concluded_intents"] == 1
        assert counts["open_intents"] == 0
        assert counts["hints"] == 1
        assert counts["chat_conversations"] == 1
        assert counts["tool_calls"] == 2
        assert counts["tokens_in"] == 250
        assert counts["tokens_out"] == 12
        assert overview["workers"] == []
        assert overview["project"]["id"] == project_id
        assert overview["recent_activity"]


def test_project_activity_feed_and_overview(runtime_env: Env) -> None:
    asyncio.run(_scenario_project_feed(runtime_env))


# ----------------------------------------------------------------- steering


def test_steering_api_and_worker_prompt(runtime_env) -> None:
    from conftest import (
        FakeClient,
        FakeContainerManager,
        FakeDriver,
        FakeLease,
        make_config,
        make_project,
    )
    from cairn.dispatcher.runtime.cancellation import TaskCancellation
    from cairn.dispatcher.runtime.process import ProcessResult
    from cairn.dispatcher.tasks import reason as reason_task

    config = make_config()
    project = make_project()
    client = FakeClient(project)
    client.steering = [
        {"id": 7, "intent_id": None, "message": "focus on the cache path", "created_by": "human"}
    ]
    containers = FakeContainerManager()
    driver = FakeDriver()
    lease = FakeLease()

    import cairn.dispatcher.tasks.reason as reason_module

    original_driver = reason_module.get_driver
    original_lease = reason_module.HeartbeatLease.for_reason
    original_run = reason_module.run_worker_process
    reason_module.get_driver = lambda *_a, **_k: driver
    reason_module.HeartbeatLease.for_reason = lambda *_a, **_k: lease
    reason_module.run_worker_process = lambda *_a, **_k: ProcessResult(
        0,
        '{"accepted":true,"data":{"intents":[{"from":["f001"],"description":"cache"}]}}',
        "",
    )
    try:
        outcome = reason_task.run_reason_task(
            config,
            client,
            containers,
            project,
            "facts:\n- id: f001\n",
            config.workers[0],
            TaskCancellation(),
        )
    finally:
        reason_module.get_driver = original_driver
        reason_module.HeartbeatLease.for_reason = original_lease
        reason_module.run_worker_process = original_run

    assert outcome == "success"
    prompt = driver.execute_prompts[0]
    assert "focus on the cache path" in prompt
    assert "Operator steering" in prompt
    assert client.delivered_steering == [("proj_001", 7, "test-worker")]


async def _scenario_steering_api(runtime_env: Env) -> None:
    async with _client() as client:
        project_id = await _create_project(client)
        response = await client.post(
            f"/projects/{project_id}/intents",
            json={"from": ["origin"], "description": "direction", "creator": "reasoner"},
        )
        assert response.status_code == 201

        created = await client.post(
            f"/projects/{project_id}/steering",
            json={"message": "prioritise auth", "created_by": "mainagent", "intent_id": "i001"},
        )
        assert created.status_code == 201, created.text
        steering = created.json()
        assert steering["status"] == "pending"
        assert steering["intent_id"] == "i001"

        pending = (await client.get(f"/projects/{project_id}/steering", params={"pending": 1})).json()
        assert pending["pending"] == 1
        assert pending["items"][0]["id"] == steering["id"]

        bad_intent = await client.post(
            f"/projects/{project_id}/steering",
            json={"message": "x", "intent_id": "i999"},
        )
        assert bad_intent.status_code == 404

        delivered = await client.post(
            f"/projects/{project_id}/steering/{steering['id']}/delivered",
            json={"worker": "test-worker", "run": "sess-1"},
        )
        assert delivered.status_code == 200, delivered.text
        assert delivered.json()["status"] == "delivered"
        assert delivered.json()["delivered_to"] == "test-worker"
        assert (await client.get(f"/projects/{project_id}/steering", params={"pending": 1})).json()[
            "pending"
        ] == 0

        feed = (await client.get(f"/projects/{project_id}/activity")).json()["items"]
        steering_events = [item for item in feed if item["kind"] == "steering"]
        assert {item["status"] for item in steering_events} == {"pending", "delivered"}


def test_steering_api(runtime_env: Env) -> None:
    asyncio.run(_scenario_steering_api(runtime_env))


# ---------------------------------------------------------------- approvals


class _ClientBridge(ControlClient):
    """ControlClient whose HTTP goes through the in-process FastAPI app."""

    def __init__(self, test_client, project_id: str) -> None:
        super().__init__("http://testserver", project_id)
        self._tc = test_client

    def request(self, method, path, *, json_body=None, timeout=None):
        response = self._tc.request(method, path, json=json_body)
        if response.status_code >= 400:
            raise ControlError(
                f"{method} {path} failed ({response.status_code}): {response.text}",
                response.status_code,
                response.json(),
            )
        return response.json() if response.content else None


def test_approval_lifecycle(runtime_env) -> None:
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        project_id = client.post(
            "/projects", json={"title": "approvals", "origin": "o", "goal": "g"}
        ).json()["project"]["id"]

        created = client.post(
            f"/projects/{project_id}/approvals",
            json={"action": "set_project_status", "payload": {"status": "stopped"},
                  "requested_by": "mainagent"},
        )
        assert created.status_code == 201, created.text
        approval = created.json()
        assert approval["status"] == "pending"
        assert approval["payload"] == {"status": "stopped"}

        listed = client.get(f"/projects/{project_id}/approvals", params={"status": "pending"}).json()
        assert listed["pending"] == 1
        assert listed["items"][0]["id"] == approval["id"]

        approved = client.post(
            f"/approvals/{approval['id']}/approve", json={"decided_by": "vic", "note": "ok"}
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "approved"
        assert approved.json()["decided_by"] == "vic"
        assert approved.json()["decided_at"]
        assert (
            client.post(f"/approvals/{approval['id']}/deny", json={"decided_by": "vic"}).status_code
            == 409
        )

        second = client.post(
            f"/projects/{project_id}/approvals",
            json={"action": "add_hint", "payload": {"content": "x"}},
        ).json()
        denied = client.post(f"/approvals/{second['id']}/deny", json={"decided_by": "vic"})
        assert denied.status_code == 200
        assert denied.json()["status"] == "denied"
        assert client.get(f"/approvals/{second['id']}").json()["status"] == "denied"

        # Expiry is real: an expired request can no longer be approved.
        expiring = client.post(
            f"/projects/{project_id}/approvals",
            json={"action": "add_hint", "payload": {}, "expires_in": 1},
        ).json()
        time.sleep(1.2)
        fetched = client.get(f"/approvals/{expiring['id']}").json()
        assert fetched["status"] == "expired"
        assert (
            client.post(f"/approvals/{expiring['id']}/approve", json={"decided_by": "vic"}).status_code
            == 409
        )

        events = client.get(f"/projects/{project_id}/activity").json()["items"]
        approval_events = [item for item in events if item["kind"] == "approval"]
        assert {"pending", "approved", "denied"} <= {item["status"] for item in approval_events}


def test_approval_gate_blocks_denied_action(runtime_env, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    with TestClient(app) as test_client:
        project_id = test_client.post(
            "/projects", json={"title": "gate", "origin": "o", "goal": "g"}
        ).json()["project"]["id"]
        bridge = _ClientBridge(test_client, project_id)

        monkeypatch.setenv("CAIRN_APPROVAL_ACTIONS", "add_hint")
        monkeypatch.setenv("CAIRN_APPROVAL_WAIT", "0")

        # Nobody decides -> the action must NOT run.
        pending = run_action(bridge, "add_hint", {"content": "should not exist"})
        assert pending["executed"] is False
        assert pending["status"] == "pending"
        hints = test_client.get(f"/projects/{project_id}").json()["hints"]
        assert hints == []

        # Deny -> still not executed.
        test_client.post(
            f"/approvals/{pending['approval_id']}/deny", json={"decided_by": "vic"}
        )
        denied = run_action(bridge, "add_hint", {"content": "still not"})
        assert denied["executed"] is False
        assert test_client.get(f"/projects/{project_id}").json()["hints"] == []
        test_client.post(
            f"/approvals/{denied['approval_id']}/deny", json={"decided_by": "vic"}
        )

        # Approve while the action is waiting -> it executes exactly once.
        def approve_soon() -> None:
            time.sleep(0.4)
            waiting = test_client.get(
                f"/projects/{project_id}/approvals", params={"status": "pending"}
            ).json()["items"]
            assert waiting, "approval request was not created"
            test_client.post(
                f"/approvals/{waiting[0]['id']}/approve",
                json={"decided_by": "vic", "note": "go ahead"},
            )

        import threading

        thread = threading.Thread(target=approve_soon)
        thread.start()
        monkeypatch.setenv("CAIRN_APPROVAL_WAIT", "5")
        approved = run_action(bridge, "add_hint", {"content": "approved hint"})
        thread.join()
        assert approved["executed"] is True
        assert approved["status"] == "approved"
        hints = test_client.get(f"/projects/{project_id}").json()["hints"]
        assert [hint["content"] for hint in hints] == ["approved hint"]


# -------------------------------------------------------------------- MCP


def test_mcp_server_protocol(runtime_env) -> None:
    init = mcp_server.handle(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"}}}
    )
    assert init["result"]["protocolVersion"] == "2025-06-18"
    assert init["result"]["serverInfo"]["name"] == "cairn-control"

    tools = mcp_server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    names = [tool["name"] for tool in tools["result"]["tools"]]
    assert names == [
        "graph_overview", "list_activity", "add_hint", "add_intent",
        "set_project_status", "steer_intent", "request_approval", "check_approval",
    ]
    for tool in tools["result"]["tools"]:
        assert tool["inputSchema"]["type"] == "object"

    unknown = mcp_server.handle({"jsonrpc": "2.0", "id": 3, "method": "nope"})
    assert unknown["error"]["code"] == -32601
    assert mcp_server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None

    # tools/call talks HTTP; with no server reachable it must report an error, not crash.
    result = mcp_server.call_tool("graph_overview", {"project_id": "proj_404"})
    assert result["isError"] is True
    assert "error" in result["content"][0]["text"].lower()


def test_mcp_stdio_roundtrip(runtime_env) -> None:
    """The server answers initialize/tools/list over real stdio."""
    process = subprocess.Popen(
        [sys.executable, "-m", "cairn.control.mcp_server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                        "clientInfo": {"name": "smoke", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]
        for request in requests:
            process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        responses = [json.loads(process.stdout.readline()) for _ in range(2)]
        assert responses[0]["result"]["protocolVersion"] == "2025-03-26"
        assert len(responses[1]["result"]["tools"]) == 8
    finally:
        process.stdin.close()
        process.wait(timeout=10)


def test_pi_extensions_are_valid_javascript(runtime_env) -> None:
    node = subprocess.run(["which", "node"], capture_output=True, text=True)
    if node.returncode != 0:
        pytest.skip("node not available")
    extensions = Path(__file__).resolve().parents[1] / "src" / "cairn" / "chat_extensions"
    for path in sorted(extensions.glob("*.js")):
        result = subprocess.run(
            ["node", "--check", str(path)], capture_output=True, text=True
        )
        assert result.returncode == 0, f"{path}: {result.stderr}"


def test_migration_is_idempotent_on_legacy_database(tmp_path, monkeypatch) -> None:
    import sqlite3

    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL);
            CREATE TABLE facts (id TEXT NOT NULL, project_id TEXT NOT NULL, description TEXT NOT NULL,
                PRIMARY KEY (id, project_id));
            CREATE TABLE intents (id TEXT NOT NULL, project_id TEXT NOT NULL, to_fact_id TEXT,
                description TEXT NOT NULL, creator TEXT NOT NULL, worker TEXT,
                last_heartbeat_at TEXT, created_at TEXT NOT NULL, concluded_at TEXT,
                PRIMARY KEY (id, project_id));
            CREATE TABLE hints (id TEXT NOT NULL, project_id TEXT NOT NULL, content TEXT NOT NULL,
                creator TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, project_id));
            INSERT INTO projects (id, title, created_at) VALUES ('proj_001', 'legacy', '2026-01-01T00:00:00Z');
            INSERT INTO intents (id, project_id, description, creator, created_at)
                VALUES ('i001', 'proj_001', 'old intent', 'human', '2026-01-01T00:00:01Z');
            """
        )
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)
    db.configure(path)  # idempotent second call is a no-op (configure guards anyway)
    with db.get_conn() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(intents)")}
        assert "priority" in columns
        row = conn.execute("SELECT priority FROM intents WHERE id = 'i001'").fetchone()
        assert row["priority"] == 0
        tables = {row["name"] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert {"chat_activities", "project_activity", "steering", "approval_requests"} <= tables
        assert activity_store.project_overview(conn, "proj_001")["counts"]["intents"] == 1


def test_chat_wiring_for_control_and_approval(runtime_env, monkeypatch) -> None:
    """The chat pi process gets the per-session control server and approval gate wired in."""
    from cairn.server import chat_runtime

    with db.get_conn() as conn:
        conn.execute(
            "INSERT INTO projects (id, title, status, bootstrap_enabled, created_at) "
            "VALUES ('proj_001', 'wiring', 'active', 1, '2026-01-01T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO chat_conversations (project_id, title, pi_session_id, status, created_at, updated_at) "
            "VALUES ('proj_001', 'c', 'sess-1', 'idle', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        )
        row = conn.execute("SELECT * FROM chat_conversations").fetchone()

    monkeypatch.setenv("CAIRN_CONTROL_URL", "http://127.0.0.1:9999")
    monkeypatch.setenv("CAIRN_CHAT_APPROVAL_TOOLS", "bash,write")

    argv = chat_runtime.build_argv("ctx", "hello", row)
    assert argv.count("--extension") == 2
    assert any(item.endswith("cairn-control.js") for item in argv)
    assert any(item.endswith("cairn-approval.js") for item in argv)
    assert argv[-1] == "hello"

    env = chat_runtime.build_child_env(row)
    assert env["CAIRN_CONTROL_URL"] == "http://127.0.0.1:9999"
    assert env["CAIRN_CONTROL_PROJECT"] == "proj_001"
    assert env["CAIRN_APPROVAL_TOOLS"] == "bash,write"
    assert env["CAIRN_APPROVAL_URL"] == "http://127.0.0.1:9999"
    assert env["CAIRN_APPROVAL_PROJECT"] == "proj_001"

    # Control extension can be turned off; with no gate tools the approval extension is absent.
    monkeypatch.setenv("CAIRN_CHAT_CONTROL", "0")
    monkeypatch.setenv("CAIRN_CHAT_APPROVAL_TOOLS", "")
    argv_off = chat_runtime.build_argv("ctx", "hello", row)
    assert "--extension" not in argv_off
