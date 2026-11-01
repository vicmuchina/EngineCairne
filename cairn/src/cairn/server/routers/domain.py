from __future__ import annotations

"""Generalized domain API: entities, findings, retests, coverage."""

from fastapi import APIRouter, HTTPException, Query

from cairn.server import domain
from cairn.server.db import get_conn
from cairn.server.models import (
    Coverage,
    CoverageGraphData,
    CreateEntityBatchRequest,
    CreateEntityRequest,
    CreateFindingRequest,
    CreateRetestRequest,
    Entity,
    Finding,
    Retest,
    RetestResultRequest,
    UpdateEntityRequest,
    UpdateFindingRequest,
)
from cairn.server.services import get_project_or_404

router = APIRouter(tags=["domain"])


def _entity_or_404(conn, project_id: str, entity_id: str) -> dict:
    for item in domain.list_entities(conn, project_id, limit=5000):
        if item["id"] == entity_id:
            return item
    raise HTTPException(404, f"Entity not found: {entity_id}")


@router.get("/projects/{project_id}/entities", response_model=list[Entity])
def list_entities(
    project_id: str,
    kind: str | None = Query(default=None),
    in_scope: bool | None = Query(default=None),
    tested: bool | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=5000),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        return domain.list_entities(
            conn, project_id, kind=kind, in_scope=in_scope, tested=tested, q=q, limit=limit
        )


@router.post("/projects/{project_id}/entities", response_model=list[Entity], status_code=201)
def upsert_entities(project_id: str, body: CreateEntityBatchRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        saved = []
        for item in body.entities:
            try:
                saved.append(domain.upsert_entity(conn, project_id, item.model_dump()))
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        return saved


@router.post("/projects/{project_id}/entity", response_model=Entity, status_code=201)
def upsert_entity(project_id: str, body: CreateEntityRequest):
    """Single-entity convenience endpoint for worker write-back."""
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        try:
            return domain.upsert_entity(conn, project_id, body.model_dump())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc


@router.patch("/projects/{project_id}/entities/{entity_id}", response_model=Entity)
def patch_entity(project_id: str, entity_id: str, body: UpdateEntityRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        row = domain.update_entity(conn, project_id, entity_id, body.model_dump(exclude_unset=True))
        if row is None:
            raise HTTPException(404, f"Entity not found: {entity_id}")
        return row


@router.post("/projects/{project_id}/entities/{entity_id}/facts", response_model=Entity)
def link_fact(
    project_id: str,
    entity_id: str,
    fact_id: str = Query(min_length=1),
    source: str = Query(default="worker"),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        _entity_or_404(conn, project_id, entity_id)
        try:
            domain.link_entity_fact(conn, project_id, entity_id, fact_id, source=source)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return _entity_or_404(conn, project_id, entity_id)


@router.get("/projects/{project_id}/coverage", response_model=Coverage)
def coverage(project_id: str, untested_limit: int = Query(default=20, ge=0, le=500)):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        return domain.compute_coverage(conn, project_id, untested_limit=untested_limit)


@router.get("/projects/{project_id}/coverage/graph", response_model=CoverageGraphData)
def coverage_graph(project_id: str):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        return domain.coverage_graph(conn, project_id)


@router.get("/projects/{project_id}/findings", response_model=list[Finding])
def list_findings(
    project_id: str,
    status: str | None = Query(default=None),
    severity: str | None = Query(default=None),
    entity_id: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=5000),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        return domain.list_findings(
            conn, project_id, status=status, severity=severity, entity_id=entity_id, q=q, limit=limit
        )


@router.post("/projects/{project_id}/findings", response_model=Finding, status_code=201)
def create_finding(project_id: str, body: CreateFindingRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        try:
            return domain.create_finding(conn, project_id, body.model_dump())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc


@router.patch("/projects/{project_id}/findings/{finding_id}", response_model=Finding)
def patch_finding(project_id: str, finding_id: str, body: UpdateFindingRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        try:
            row = domain.update_finding(
                conn, project_id, finding_id, body.model_dump(exclude_unset=True)
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if row is None:
            raise HTTPException(404, f"Finding not found: {finding_id}")
        return row


@router.get("/projects/{project_id}/retests", response_model=list[Retest])
def list_retests(
    project_id: str,
    finding_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=5000),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        return domain.list_retests(conn, project_id, finding_id=finding_id, status=status, limit=limit)


@router.post("/projects/{project_id}/findings/{finding_id}/retests", response_model=Retest, status_code=201)
def create_retest(project_id: str, finding_id: str, body: CreateRetestRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        try:
            return domain.create_retest(
                conn, project_id, finding_id, notes=body.notes, worker=body.worker
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc


@router.patch("/projects/{project_id}/retests/{retest_id}", response_model=Retest)
def patch_retest(project_id: str, retest_id: str, body: RetestResultRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        try:
            row = domain.finish_retest(
                conn,
                project_id,
                retest_id,
                verdict=body.verdict,
                summary=body.summary,
                evidence=body.evidence,
                notes=body.notes,
                status=body.status,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if row is None:
            raise HTTPException(404, f"Retest not found: {retest_id}")
        return row


@router.post("/projects/{project_id}/intents/{intent_id}/retest-result", response_model=Retest)
def retest_result_by_intent(project_id: str, intent_id: str, body: RetestResultRequest):
    """Worker write-back: report the verdict for the retest this intent is running."""
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        try:
            row = domain.finish_retest_for_intent(
                conn,
                project_id,
                intent_id,
                verdict=body.verdict,
                summary=body.summary,
                evidence=body.evidence,
                notes=body.notes,
                status=body.status,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if row is None:
            raise HTTPException(404, f"No retest for intent {intent_id}")
        return row
