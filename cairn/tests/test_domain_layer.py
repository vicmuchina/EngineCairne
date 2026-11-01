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
        json={"title": "domain-test", "origin": "start", "goal": "finish", "bootstrap_enabled": False},
    )
    assert response.status_code == 201, response.text
    return response.json()["project"]["id"]


def _fact(client: TestClient, project_id: str, description: str = "observed behaviour") -> str:
    intent = client.post(
        f"/projects/{project_id}/intents",
        json={"from": ["origin"], "description": "probe", "creator": "w1", "worker": "w1"},
    )
    assert intent.status_code == 201, intent.text
    iid = intent.json()["id"]
    concluded = client.post(
        f"/projects/{project_id}/intents/{iid}/conclude",
        json={"worker": "w1", "description": description},
    )
    assert concluded.status_code == 200, concluded.text
    return concluded.json()["fact"]["id"]


def _entity(client: TestClient, project_id: str, **payload):
    body = {"kind": "host", "key": "portal.example.com", "label": "Portal"}
    body.update(payload)
    return client.post(f"/projects/{project_id}/entity", json=body)


def test_entity_upsert_dedupes_and_advances_coverage(client: TestClient) -> None:
    project_id = _project(client)
    fact_id = _fact(client, project_id)

    first = _entity(client, project_id, facts=[fact_id])
    assert first.status_code == 201, first.text
    entity_id = first.json()["id"]
    assert first.json()["tested"] is True

    # Re-posting the same kind+key updates the same row, not a new one.
    second = _entity(client, project_id, label="Portal (renamed)")
    assert second.status_code == 201, second.text
    assert second.json()["id"] == entity_id
    assert second.json()["label"] == "Portal (renamed)"

    listed = client.get(f"/projects/{project_id}/entities").json()
    assert len(listed) == 1
    assert listed[0]["fact_count"] == 1

    coverage = client.get(f"/projects/{project_id}/coverage").json()
    assert coverage["denominator"] == 1
    assert coverage["tested"] == 1
    assert coverage["pct"] == 1.0


def test_coverage_counts_anchored_out_of_scope_and_lists_untested(client: TestClient) -> None:
    project_id = _project(client)
    fact_id = _fact(client, project_id)
    _entity(client, project_id, key="scoped.example.com", in_scope=True)
    _entity(
        client,
        project_id,
        key="discovered.example.com",
        in_scope=False,
        facts=[fact_id],
    )
    coverage = client.get(f"/projects/{project_id}/coverage").json()
    # denominator = in-scope (1) + anchored out-of-scope (1); tested = anchored (1)
    assert coverage["denominator"] == 2
    assert coverage["tested"] == 1
    assert coverage["pct"] == 0.5
    assert [item["key"] for item in coverage["untested"]] == ["scoped.example.com"]


def test_entity_scope_is_not_reset_by_a_later_worker_repost(client: TestClient) -> None:
    project_id = _project(client)
    created = _entity(client, project_id, key="keep.example.com", in_scope=True).json()
    patched = client.patch(
        f"/projects/{project_id}/entities/{created['id']}", json={"in_scope": False}
    )
    assert patched.status_code == 200
    assert patched.json()["in_scope"] is False
    # A worker that reposts without in_scope must not silently re-expand the scope.
    _entity(client, project_id, key="keep.example.com")
    listed = client.get(f"/projects/{project_id}/entities").json()
    assert listed[0]["in_scope"] is False


def test_finding_and_retest_lifecycle_updates_finding_status(client: TestClient) -> None:
    project_id = _project(client)
    fact_id = _fact(client, project_id)
    entity = _entity(client, project_id, facts=[fact_id]).json()
    finding = client.post(
        f"/projects/{project_id}/findings",
        json={
            "title": "Unauthenticated object read",
            "klass": "access control",
            "severity": "high",
            "summary": "GET /objects/1 returns another tenant's object",
            "evidence": "HTTP 200 + body hash",
            "fact_id": fact_id,
            "entities": [entity["id"]],
        },
    )
    assert finding.status_code == 201, finding.text
    finding_id = finding.json()["id"]
    assert finding.json()["entity_ids"] == [entity["id"]]

    first = client.post(f"/projects/{project_id}/findings/{finding_id}/retests", json={"notes": "after fix"})
    assert first.status_code == 201, first.text
    retest = first.json()
    assert retest["status"] == "pending"
    assert retest["intent_id"]

    # Exactly one active retest per finding.
    second = client.post(f"/projects/{project_id}/findings/{finding_id}/retests", json={}).json()
    assert second["id"] == retest["id"]

    intent = client.get(f"/projects/{project_id}").json()["intents"]
    retest_intent = next(item for item in intent if item["id"] == retest["intent_id"])
    assert retest_intent["kind"] == "retest"
    assert retest_intent["retest_of"] == finding_id

    result = client.patch(
        f"/projects/{project_id}/retests/{retest['id']}",
        json={"verdict": "fixed", "summary": "replay returns 403", "evidence": "curl -i"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "completed"
    assert result.json()["verdict"] == "fixed"

    finding_after = client.get(f"/projects/{project_id}/findings").json()[0]
    assert finding_after["status"] == "fixed"
    assert finding_after["retests"][0]["verdict"] == "fixed"


def test_retest_conclude_without_verdict_is_inconclusive(client: TestClient) -> None:
    project_id = _project(client)
    fact_id = _fact(client, project_id)
    finding = client.post(
        f"/projects/{project_id}/findings",
        json={"title": "x", "fact_id": fact_id},
    ).json()
    retest = client.post(f"/projects/{project_id}/findings/{finding['id']}/retests", json={}).json()
    intent_id = retest["intent_id"]

    heartbeat = client.post(
        f"/projects/{project_id}/intents/{intent_id}/heartbeat", json={"worker": "w2"}
    )
    assert heartbeat.status_code == 200, heartbeat.text
    running = client.get(f"/projects/{project_id}/retests").json()[0]
    assert running["status"] == "running"

    concluded = client.post(
        f"/projects/{project_id}/intents/{intent_id}/conclude",
        json={"worker": "w2", "description": "could not repeat: the endpoint moved"},
    )
    assert concluded.status_code == 200, concluded.text
    sealed = client.get(f"/projects/{project_id}/retests").json()[0]
    assert sealed["status"] == "completed"
    assert sealed["verdict"] == "inconclusive"


def test_project_detail_and_report_include_the_domain_layer(client: TestClient) -> None:
    project_id = _project(client)
    fact_id = _fact(client, project_id)
    entity = _entity(client, project_id, facts=[fact_id]).json()
    client.post(
        f"/projects/{project_id}/findings",
        json={"title": "Leaked token", "severity": "critical", "fact_id": fact_id, "entities": [entity["id"]]},
    )
    detail = client.get(f"/projects/{project_id}").json()
    assert len(detail["entities"]) == 1
    assert len(detail["findings"]) == 1
    assert detail["coverage"]["denominator"] == 1

    report = client.get(f"/projects/{project_id}/report").json()["markdown"]
    for heading in (
        "## Scope and coverage",
        "## Findings",
        "## Confirmed facts",
        "## Intent ledger",
    ):
        assert heading in report, heading


def test_entity_anchored_to_a_concluded_intent_counts_as_tested(client: TestClient) -> None:
    project_id = _project(client)
    intent = client.post(
        f"/projects/{project_id}/intents",
        json={"from": ["origin"], "description": "inventory", "creator": "w1", "worker": "w1"},
    ).json()
    entity = _entity(client, project_id, intent_id=intent["id"]).json()
    assert entity["tested"] is False
    coverage = client.get(f"/projects/{project_id}/coverage").json()
    assert coverage["denominator"] == 1
    assert coverage["tested"] == 0

    client.post(
        f"/projects/{project_id}/intents/{intent['id']}/conclude",
        json={"worker": "w1", "description": "inventory complete"},
    )
    coverage = client.get(f"/projects/{project_id}/coverage").json()
    assert coverage["tested"] == 1
    assert coverage["pct"] == 1.0
