from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from cairn.server import db
from cairn.server.app import app


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "cairn.db")
    with TestClient(app) as test_client:
        yield test_client


def _project(client: TestClient) -> str:
    response = client.post(
        "/projects",
        json={"title": "activity-test", "origin": "start", "goal": "finish", "bootstrap_enabled": False},
    )
    assert response.status_code == 201, response.text
    return response.json()["project"]["id"]


def _activity(client: TestClient, project_id: str, index: int, *, long: bool = False) -> None:
    response = client.post(
        f"/projects/{project_id}/activity",
        json={
            "kind": "tool_result",
            "title": f"result {index}",
            "description": f"result body {index}",
            "metadata": {"tool_output": ("x" * 5000) if long else "small"},
        },
    )
    assert response.status_code == 201, response.text


def test_newest_first_walks_back_with_before_cursor(client: TestClient) -> None:
    project_id = _project(client)
    for index in range(1, 9):
        _activity(client, project_id, index)

    first = client.get(
        f"/projects/{project_id}/activity",
        params={"limit": 3, "newest_first": "true", "kinds": "tool_result"},
    ).json()
    assert [item["id"] for item in first["items"]] == ["event:9", "event:8", "event:7"]
    assert first["has_more"] is True
    assert first["next_cursor"]

    second = client.get(
        f"/projects/{project_id}/activity",
        params={
            "limit": 3,
            "newest_first": "true",
            "before": first["next_cursor"],
            "kinds": "tool_result",
        },
    ).json()
    assert [item["id"] for item in second["items"]] == ["event:6", "event:5", "event:4"]
    assert second["has_more"] is True

    third = client.get(
        f"/projects/{project_id}/activity",
        params={
            "limit": 3,
            "newest_first": "true",
            "before": second["next_cursor"],
            "kinds": "tool_result",
        },
    ).json()
    assert [item["id"] for item in third["items"]] == ["event:3", "event:2"]
    assert third["has_more"] is False


def test_compact_bounds_metadata_strings(client: TestClient) -> None:
    project_id = _project(client)
    _activity(client, project_id, 1, long=True)

    full = client.get(
        f"/projects/{project_id}/activity", params={"limit": 10, "kinds": "tool_result"}
    ).json()
    posted = next(item for item in full["items"] if item["id"] == "event:2")
    assert len(posted["metadata"]["tool_output"]) == 5000

    compact = client.get(
        f"/projects/{project_id}/activity",
        params={"limit": 10, "compact": "true", "kinds": "tool_result"},
    ).json()
    value = next(item for item in compact["items"] if item["id"] == "event:2")["metadata"]["tool_output"]
    assert len(value) <= 181
    assert value.endswith("…")
