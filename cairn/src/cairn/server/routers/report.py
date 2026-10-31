from __future__ import annotations

"""Deterministic project report endpoint (Markdown, no LLM)."""

from fastapi import APIRouter, HTTPException

from cairn.server import report as report_store
from cairn.server.db import get_conn
from cairn.server.models import ProjectReport
from cairn.server.services import get_project_or_404

router = APIRouter(tags=["report"])


@router.get("/projects/{project_id}/report", response_model=ProjectReport)
def get_project_report(project_id: str):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        try:
            payload = report_store.build_project_report(conn, project_id)
        except LookupError:  # pragma: no cover - get_project_or_404 already guards
            raise HTTPException(404, f"Unknown project: {project_id}")
    return ProjectReport(**payload)
