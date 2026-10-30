from fastapi import APIRouter, HTTPException, Query

from cairn.server import activity as activity_store
from cairn.server.db import get_conn
from cairn.server.models import (
    CompleteRequest,
    CreateProjectRequest,
    Fact,
    Hint,
    HeartbeatRequest,
    Intent,
    ProjectActivityCreate,
    ProjectActivityFeed,
    ProjectActivityItem,
    ProjectDetail,
    ProjectMeta,
    ProjectOverview,
    ProjectSummary,
    ReopenRequest,
    ReopenResponse,
    ReasonClaimRequest,
    UpdateProjectTitleRequest,
    UpdateProjectStatusRequest,
)
from cairn.server.services import (
    build_intents,
    check_project_completed,
    check_project_active,
    clear_project_reason,
    expire_reason_leases,
    expire_workers,
    get_completion_intent_or_409,
    get_project_or_404,
    intent_to_model,
    next_fact_id,
    next_hint_id,
    next_intent_id,
    next_project_id,
    project_meta_from_row,
    project_reason_from_row,
    utcnow,
    validate_facts_exist,
    validate_goal_not_in_sources,
)

router = APIRouter(tags=["projects"])


@router.get("/projects", response_model=list[ProjectSummary])
def list_projects():
    with get_conn() as conn:
        expire_workers(conn)
        expire_reason_leases(conn)
        rows = conn.execute("""
            SELECT p.*,
                (SELECT COUNT(*) FROM facts WHERE project_id = p.id) AS fact_count,
                (SELECT COUNT(*) FROM intents WHERE project_id = p.id) AS intent_count,
                (SELECT COUNT(*) FROM intents WHERE project_id = p.id AND concluded_at IS NULL AND worker IS NOT NULL) AS working_intent_count,
                (SELECT COUNT(*) FROM intents WHERE project_id = p.id AND concluded_at IS NULL AND worker IS NULL) AS unclaimed_intent_count,
                (SELECT COUNT(*) FROM hints WHERE project_id = p.id) AS hint_count
            FROM projects p
            ORDER BY p.created_at
        """).fetchall()
        return [
            ProjectSummary(
                id=row["id"],
                title=row["title"],
                status=row["status"],
                bootstrap_enabled=bool(row["bootstrap_enabled"]),
                created_at=row["created_at"],
                reason=project_reason_from_row(row),
                fact_count=row["fact_count"],
                intent_count=row["intent_count"],
                working_intent_count=row["working_intent_count"],
                unclaimed_intent_count=row["unclaimed_intent_count"],
                hint_count=row["hint_count"],
            )
            for row in rows
        ]


@router.post("/projects", response_model=ProjectDetail, status_code=201)
def create_project(body: CreateProjectRequest):
    with get_conn() as conn:
        pid = next_project_id(conn)
        now = utcnow()

        conn.execute(
            "INSERT INTO projects (id, title, status, bootstrap_enabled, created_at) VALUES (?, ?, 'active', ?, ?)",
            (pid, body.title, body.bootstrap_enabled, now),
        )
        conn.execute(
            "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
            ("origin", pid, body.origin),
        )
        conn.execute(
            "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
            ("goal", pid, body.goal),
        )

        hints = []
        if body.hints:
            for h in body.hints:
                hid = next_hint_id(conn, pid)
                conn.execute(
                    "INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
                    (hid, pid, h.content, h.creator, now),
                )
                hints.append(Hint(id=hid, content=h.content, creator=h.creator, created_at=now))

        activity_store.record_activity(
            conn,
            pid,
            kind="project",
            title="Project created",
            description=body.title,
            actor="human",
            status="active",
            metadata={"bootstrap_enabled": body.bootstrap_enabled},
            created_at=now,
        )

        return ProjectDetail(
            project=ProjectMeta(
                id=pid,
                title=body.title,
                status="active",
                bootstrap_enabled=body.bootstrap_enabled,
                created_at=now,
                reason=None,
            ),
            facts=[
                Fact(id="origin", description=body.origin),
                Fact(id="goal", description=body.goal),
            ],
            intents=[],
            hints=hints,
        )


@router.get("/projects/{project_id}", response_model=ProjectDetail)
def get_project(project_id: str):
    with get_conn() as conn:
        expire_workers(conn, project_id)
        expire_reason_leases(conn, project_id)
        row = get_project_or_404(conn, project_id)

        facts = conn.execute(
            "SELECT * FROM facts WHERE project_id = ?", (project_id,)
        ).fetchall()
        hints = conn.execute(
            "SELECT * FROM hints WHERE project_id = ? ORDER BY created_at",
            (project_id,),
        ).fetchall()

        return ProjectDetail(
            project=project_meta_from_row(row),
            facts=[Fact(**dict(f)) for f in facts],
            intents=build_intents(conn, project_id),
            hints=[Hint(**dict(h)) for h in hints],
        )


@router.get("/projects/{project_id}/activity", response_model=ProjectActivityFeed)
def project_activity(
    project_id: str,
    after: str | None = Query(default=None, description="Cursor from a previous next_cursor"),
    limit: int = Query(default=50, ge=1, le=500),
    kinds: str | None = Query(default=None, description="Comma-separated feed kinds"),
):
    """Unified chronological feed: facts, intents, hints, worker/steering/approval events, chat."""
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        kind_list = [item.strip() for item in kinds.split(",") if item.strip()] if kinds else None
        payload = activity_store.build_project_activity(
            conn, project_id, after=after, limit=limit, kinds=kind_list
        )
        return ProjectActivityFeed(**payload)


@router.get("/projects/{project_id}/overview", response_model=ProjectOverview)
def project_overview(project_id: str):
    """Project summary + real counts + recent activity (no synthesized fields)."""
    with get_conn() as conn:
        expire_workers(conn, project_id)
        expire_reason_leases(conn, project_id)
        row = get_project_or_404(conn, project_id)
        payload = activity_store.project_overview(conn, project_id)
        return ProjectOverview(
            project=project_meta_from_row(row),
            project_id=project_id,
            generated_at=payload["generated_at"],
            counts=payload["counts"],
            workers=payload["workers"],
            recent_activity=payload["recent_activity"],
            recent_activity_order=payload.get("recent_activity_order", "newest_first"),
        )


@router.post("/projects/{project_id}/activity", response_model=ProjectActivityItem, status_code=201)
def append_project_activity(project_id: str, body: ProjectActivityCreate):
    """Activity writer for dispatcher/worker events (best-effort on the dispatcher side)."""
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        activity_id = activity_store.record_activity(
            conn,
            project_id,
            kind=body.kind,
            title=body.title,
            description=body.description,
            actor=body.actor,
            status=body.status,
            metadata=body.metadata,
            source=body.source,
            run_id=body.run_id,
        )
        row = conn.execute(
            "SELECT * FROM project_activity WHERE id = ?", (activity_id,)
        ).fetchone()
        metadata = body.metadata
        return ProjectActivityItem(
            kind=row["kind"],
            id=f"event:{row['id']}",
            project_id=project_id,
            timestamp=row["created_at"],
            timestamp_source="project_activity.created_at",
            actor=row["actor"],
            status=row["status"],
            title=row["title"],
            description=row["description"],
            metadata=metadata,
            source=row["source"],
            cursor=f"{row['created_at']}#event:{row['id']}",
            run_id=row["run_id"],
        )


@router.delete("/projects/{project_id}", status_code=204)
async def delete_project(project_id: str):
    from cairn.server import pi_rpc

    with get_conn() as conn:
        get_project_or_404(conn, project_id)
    # Warm chat sessions hold a live pi process for this project; close them before the
    # conversations (and their rows) disappear, or the process would be orphaned.
    await pi_rpc.manager().close_for_project(project_id)
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))


@router.put("/projects/{project_id}/title", response_model=ProjectMeta)
def update_project_title(project_id: str, body: UpdateProjectTitleRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        conn.execute(
            "UPDATE projects SET title = ? WHERE id = ?",
            (body.title, project_id),
        )
        updated = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return project_meta_from_row(updated)


@router.put("/projects/{project_id}/status", response_model=ProjectMeta)
def update_project_status(project_id: str, body: UpdateProjectStatusRequest):
    with get_conn() as conn:
        expire_reason_leases(conn, project_id)
        row = get_project_or_404(conn, project_id)
        current_status = row["status"]
        if current_status == "completed":
            raise HTTPException(409, "Completed projects cannot change status")
        if current_status == body.status:
            return project_meta_from_row(row)

        conn.execute(
            "UPDATE projects SET status = ? WHERE id = ?",
            (body.status, project_id),
        )
        if body.status == "stopped":
            conn.execute(
                "UPDATE intents SET worker = NULL WHERE project_id = ? AND concluded_at IS NULL",
                (project_id,),
            )
            clear_project_reason(conn, project_id)
        activity_store.record_activity(
            conn,
            project_id,
            kind="status",
            title=f"Project status changed to {body.status}",
            actor=body.actor,
            status=body.status,
            metadata={"from": current_status, "to": body.status},
        )
        updated = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return project_meta_from_row(updated)


@router.post("/projects/{project_id}/reason/claim", response_model=ProjectMeta)
def claim_project_reason(project_id: str, body: ReasonClaimRequest):
    with get_conn() as conn:
        check_project_active(conn, project_id)
        expire_reason_leases(conn, project_id)
        row = get_project_or_404(conn, project_id)
        current_worker = row["reason_worker"]
        if current_worker is not None and current_worker != body.worker:
            raise HTTPException(409, f"Project reason is currently claimed by {current_worker}")
        if current_worker == body.worker:
            return project_meta_from_row(row)

        now = utcnow()
        conn.execute(
            """
            UPDATE projects
            SET reason_worker = ?,
                reason_trigger = ?,
                reason_started_at = ?,
                reason_last_heartbeat_at = ?
            WHERE id = ?
            """,
            (body.worker, body.trigger, now, now, project_id),
        )
        updated = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return project_meta_from_row(updated)


@router.post("/projects/{project_id}/reason/heartbeat", response_model=ProjectMeta)
def heartbeat_project_reason(project_id: str, body: HeartbeatRequest):
    with get_conn() as conn:
        check_project_active(conn, project_id)
        expire_reason_leases(conn, project_id)
        row = get_project_or_404(conn, project_id)
        current_worker = row["reason_worker"]
        if current_worker is None:
            raise HTTPException(409, "Project reason is not currently claimed")
        if current_worker != body.worker:
            raise HTTPException(409, f"Project reason is currently claimed by {current_worker}")

        now = utcnow()
        conn.execute(
            "UPDATE projects SET reason_last_heartbeat_at = ? WHERE id = ?",
            (now, project_id),
        )
        updated = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return project_meta_from_row(updated)


@router.post("/projects/{project_id}/reason/release", response_model=ProjectMeta)
def release_project_reason(project_id: str, body: HeartbeatRequest):
    with get_conn() as conn:
        check_project_active(conn, project_id)
        expire_reason_leases(conn, project_id)
        row = get_project_or_404(conn, project_id)
        current_worker = row["reason_worker"]
        if current_worker is None:
            return project_meta_from_row(row)
        if current_worker != body.worker:
            raise HTTPException(409, f"Project reason is currently claimed by {current_worker}")

        clear_project_reason(conn, project_id)
        updated = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return project_meta_from_row(updated)


@router.post("/projects/{project_id}/complete", response_model=Intent)
def complete_project(project_id: str, body: CompleteRequest):
    with get_conn() as conn:
        check_project_active(conn, project_id)
        expire_reason_leases(conn, project_id)
        validate_facts_exist(conn, project_id, body.from_)
        validate_goal_not_in_sources(body.from_)

        now = utcnow()
        iid = next_intent_id(conn, project_id)

        conn.execute(
            "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, 'goal', ?, ?, ?, ?, ?, ?)",
            (iid, project_id, body.description, body.worker, body.worker, now, now, now),
        )
        for fid in body.from_:
            conn.execute(
                "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
                (iid, project_id, fid),
            )
        conn.execute(
            """
            UPDATE projects
            SET status = 'completed',
                reason_worker = NULL,
                reason_trigger = NULL,
                reason_started_at = NULL,
                reason_last_heartbeat_at = NULL
            WHERE id = ?
            """,
            (project_id,),
        )

        return Intent(
            id=iid,
            **{"from": body.from_},
            to="goal",
            description=body.description,
            creator=body.worker,
            worker=body.worker,
            last_heartbeat_at=now,
            created_at=now,
            concluded_at=now,
        )


@router.post("/projects/{project_id}/reopen", response_model=ReopenResponse)
def reopen_project(project_id: str, body: ReopenRequest):
    with get_conn() as conn:
        expire_reason_leases(conn, project_id)
        check_project_completed(conn, project_id)
        completion = get_completion_intent_or_409(conn, project_id)

        source_rows = conn.execute(
            "SELECT fact_id FROM intent_sources WHERE intent_id = ? AND project_id = ? ORDER BY rowid",
            (completion["id"], project_id),
        ).fetchall()
        source_ids = [row["fact_id"] for row in source_rows]
        if not source_ids:
            raise HTTPException(409, "Completion intent is missing its source facts")

        now = utcnow()
        fact_id = next_fact_id(conn, project_id)
        intent_id = next_intent_id(conn, project_id)
        description = body.description
        creator = body.creator

        conn.execute(
            "DELETE FROM intents WHERE id = ? AND project_id = ?",
            (completion["id"], project_id),
        )
        conn.execute(
            "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
            (fact_id, project_id, description),
        )
        conn.execute(
            "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (intent_id, project_id, fact_id, "external_feedback", creator, creator, now, now, now),
        )
        for source_id in source_ids:
            conn.execute(
                "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
                (intent_id, project_id, source_id),
            )
        clear_project_reason(conn, project_id)
        conn.execute(
            "UPDATE projects SET status = 'active' WHERE id = ?",
            (project_id,),
        )

        updated_project = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        updated_intent = conn.execute(
            "SELECT * FROM intents WHERE id = ? AND project_id = ?",
            (intent_id, project_id),
        ).fetchone()
        assert updated_project is not None
        assert updated_intent is not None
        return ReopenResponse(
            project=project_meta_from_row(updated_project),
            fact=Fact(id=fact_id, description=description),
            intent=intent_to_model(conn, updated_intent, project_id),
        )
