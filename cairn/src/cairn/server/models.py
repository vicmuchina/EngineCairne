from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Settings(BaseModel):
    intent_timeout: int = Field(ge=5)
    reason_timeout: int = Field(ge=5)


class Fact(BaseModel):
    id: str
    description: str


class Intent(BaseModel):
    id: str
    from_: list[str] = Field(alias="from")
    to: str | None = None
    description: str
    creator: str
    worker: str | None = None
    last_heartbeat_at: str | None = None
    created_at: str
    concluded_at: str | None = None
    priority: int = 0
    # Domain layer: "explore" (default) or "retest" (re-verifies a finding).
    kind: str = "explore"
    retest_of: str | None = None

    model_config = {"populate_by_name": True}


class Hint(BaseModel):
    id: str
    content: str
    creator: str
    created_at: str


class ProjectReason(BaseModel):
    worker: str
    trigger: str
    started_at: str
    last_heartbeat_at: str


class ProjectMeta(BaseModel):
    id: str
    title: str
    status: Literal["active", "stopped", "completed"]
    bootstrap_enabled: bool
    created_at: str
    reason: ProjectReason | None = None


class ProjectSummary(ProjectMeta):
    fact_count: int
    intent_count: int
    working_intent_count: int
    unclaimed_intent_count: int
    hint_count: int


class ProjectDetail(BaseModel):
    project: ProjectMeta
    facts: list[Fact]
    intents: list[Intent]
    hints: list[Hint]
    # Domain layer (additive; empty for projects that do not use it).
    entities: list["Entity"] = Field(default_factory=list)
    findings: list["Finding"] = Field(default_factory=list)
    retests: list["Retest"] = Field(default_factory=list)
    coverage: "Coverage | None" = None


class CreateHintInline(BaseModel):
    content: str
    creator: str

    @field_validator("content", "creator")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class CreateProjectRequest(BaseModel):
    title: str
    origin: str
    goal: str
    bootstrap_enabled: bool = True
    hints: list[CreateHintInline] | None = None

    @field_validator("title", "origin", "goal")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class CreateHintRequest(BaseModel):
    content: str
    creator: str

    @field_validator("content", "creator")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class CreateIntentRequest(BaseModel):
    from_: list[str] = Field(alias="from", min_length=1)
    description: str
    creator: str
    worker: str | None = None
    priority: int = Field(default=0, ge=0)
    # "explore" (default) or "retest" (re-verifies a finding).
    kind: str = Field(default="explore", pattern="^(explore|retest)$")
    retest_of: str | None = None

    model_config = {"populate_by_name": True}

    @field_validator("description", "creator", "worker")
    @classmethod
    def validate_non_empty_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text

    @field_validator("from_")
    @classmethod
    def validate_fact_ids(cls, value: list[str]) -> list[str]:
        cleaned = []
        for item in value:
            text = item.strip()
            if not text:
                raise ValueError("fact ids must not be empty")
            cleaned.append(text)
        return cleaned


class HeartbeatRequest(BaseModel):
    worker: str

    @field_validator("worker")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ReasonClaimRequest(BaseModel):
    worker: str
    trigger: str

    @field_validator("worker", "trigger")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ConcludeRequest(BaseModel):
    worker: str
    description: str

    @field_validator("worker", "description")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class CompleteRequest(BaseModel):
    from_: list[str] = Field(alias="from", min_length=1)
    description: str
    worker: str

    model_config = {"populate_by_name": True}

    @field_validator("description", "worker")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text

    @field_validator("from_")
    @classmethod
    def validate_fact_ids(cls, value: list[str]) -> list[str]:
        cleaned = []
        for item in value:
            text = item.strip()
            if not text:
                raise ValueError("fact ids must not be empty")
            cleaned.append(text)
        return cleaned


class ConcludeResponse(BaseModel):
    fact: Fact
    intent: Intent


class UpdateProjectStatusRequest(BaseModel):
    status: Literal["active", "stopped"]
    actor: str | None = None


class UpdateProjectTitleRequest(BaseModel):
    title: str

    @field_validator("title")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ReopenRequest(BaseModel):
    description: str
    creator: str

    @field_validator("description", "creator")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ReopenResponse(BaseModel):
    project: ProjectMeta
    fact: Fact
    intent: Intent


class ProjectActivityItem(BaseModel):
    kind: str
    id: str
    project_id: str
    timestamp: str | None = None
    timestamp_source: str
    actor: str | None = None
    status: str | None = None
    title: str
    description: str | None = None
    metadata: dict = Field(default_factory=dict)
    source: str
    cursor: str | None = None
    # Worker transcript rows only: groups a dispatcher process run. None for facts,
    # intents, hints, chat and every other activity kind.
    run_id: str | None = None


class ProjectActivityFeed(BaseModel):
    items: list[ProjectActivityItem]
    next_cursor: str | None = None
    has_more: bool
    project_id: str


class ProjectActivityCreate(BaseModel):
    kind: str = Field(min_length=1)
    title: str = Field(min_length=1)
    description: str | None = None
    actor: str | None = None
    status: str | None = None
    metadata: dict = Field(default_factory=dict)
    source: str = "dispatcher"
    run_id: str | None = Field(default=None, max_length=128)


class WorkerRunCounts(BaseModel):
    activities: int = 0
    thinking: int = 0
    tool_calls: int = 0
    tool_results: int = 0
    messages: int = 0
    errors: int = 0


class TokenUsage(BaseModel):
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    reasoning: int = 0
    total_tokens: int = 0
    cost: float = 0.0


class SessionTokens(BaseModel):
    input: int = 0
    cache_read: int = 0
    output: int = 0
    cost: float = 0.0


class WorkerRunItem(BaseModel):
    run_id: str
    project_id: str
    worker: str
    task: str | None = None
    intent_id: str | None = None
    intent_description: str | None = None
    status: str
    active: bool = False
    stale: bool = False
    started_at: str | None = None
    finished_at: str | None = None
    last_event_at: str | None = None
    duration_ms: int | None = None
    error: str | None = None
    session: str | None = None
    model: str | None = None
    usage: TokenUsage = Field(default_factory=TokenUsage)
    transcript_truncated: bool = False
    counts: WorkerRunCounts = Field(default_factory=WorkerRunCounts)
    transcript: list[ProjectActivityItem] = Field(default_factory=list)


class WorkerRunList(BaseModel):
    items: list[WorkerRunItem]
    project_id: str
    generated_at: str
    active_count: int = 0


class SessionRunPhase(BaseModel):
    """One dispatcher run that belongs to a merged worker session (provenance)."""

    run_id: str
    task: str | None = None
    status: str
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    usage: TokenUsage = Field(default_factory=TokenUsage)
    model: str | None = None


class SessionInterruption(BaseModel):
    """Structured interruption report attached to an interrupted planner round."""

    reason: str
    terminal_state: str
    turns: int = 0
    duration_ms: int | None = None
    usage: dict = Field(default_factory=dict)
    tool: dict | None = None
    text: str = ""
    run_id: str | None = None


class SessionItem(BaseModel):
    key: str
    role: str
    title: str
    status: str
    live: bool = False
    last_activity_at: str | None = None
    tokens: SessionTokens = Field(default_factory=SessionTokens)
    unread: int = 0
    run_id: str | None = None
    worker: str | None = None
    task: str | None = None
    intent_id: str | None = None
    stale: bool = False
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None
    model: str | None = None
    counts: WorkerRunCounts | None = None
    # --- sessions v2 (all additive) -------------------------------------
    intent_description: str | None = None
    usage: TokenUsage | None = None
    queued: bool = False
    runs: list[SessionRunPhase] = Field(default_factory=list)
    phases: dict[str, str | None] | None = None
    interrupted: bool = False
    interrupt_reason: str | None = None
    round: int | None = None
    summary: dict | None = None
    summary_text: str | None = None


class SessionList(BaseModel):
    project_id: str
    generated_at: str
    project_status: str
    task_total: SessionTokens = Field(default_factory=SessionTokens)
    sessions: list[SessionItem] = Field(default_factory=list)


class SessionTool(BaseModel):
    name: str | None = None
    call_id: str | None = None
    input: str | None = None
    output: str | None = None
    duration_ms: int | None = None
    is_error: bool = False


class SessionActivityTokens(BaseModel):
    input: int = 0
    output: int = 0
    cache_read: int = 0


class SessionActivityItem(BaseModel):
    seq: int
    id: int
    kind: str
    role: str | None = None
    status: str = "done"
    content: str | None = None
    tool: SessionTool | None = None
    tokens: SessionActivityTokens = Field(default_factory=SessionActivityTokens)
    metadata: dict = Field(default_factory=dict)
    created_at: str


class SessionActivityPage(BaseModel):
    key: str
    items: list[SessionActivityItem] = Field(default_factory=list)
    has_more: bool = False
    earliest_seq: int | None = None


class ProjectReport(BaseModel):
    project_id: str
    generated_at: str
    markdown: str
    counts: dict = Field(default_factory=dict)


class ClaimReconcileRequest(BaseModel):
    claim_stale_seconds: int = Field(default=1800, ge=1)
    dry_run: bool = False


class ClaimReconcileResponse(BaseModel):
    project_id: str
    generated_at: str
    checked: int
    released: int
    protected: int
    skipped_fresh: int
    released_intents: list[dict] = Field(default_factory=list)


class WorkerRunCloseRequest(BaseModel):
    status: Literal["success", "failed", "timeout", "cancelled", "error", "stopped"] = "success"
    error: str | None = None
    metadata: dict = Field(default_factory=dict)


class WorkerActivityUpdate(BaseModel):
    status: str | None = Field(default=None, max_length=32)
    description: str | None = None
    error: str | None = None
    metadata: dict | None = None


class ProjectOverview(BaseModel):
    project: ProjectMeta
    project_id: str
    generated_at: str
    counts: dict[str, int]
    workers: list[dict]
    recent_activity: list[ProjectActivityItem]
    recent_activity_order: str = "newest_first"


class SteeringCreateRequest(BaseModel):
    message: str = Field(min_length=1)
    created_by: str = "mainagent"
    intent_id: str | None = None

    @field_validator("message", "created_by")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text

    @field_validator("intent_id")
    @classmethod
    def validate_intent_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        return text or None


class SteeringItem(BaseModel):
    id: int
    project_id: str
    intent_id: str | None = None
    message: str
    created_by: str
    created_at: str
    status: Literal["pending", "delivered", "cancelled"]
    delivered_at: str | None = None
    delivered_to: str | None = None
    delivered_run: str | None = None


class SteeringList(BaseModel):
    items: list[SteeringItem]
    pending: int


class SteeringDeliverRequest(BaseModel):
    worker: str
    run: str | None = None

    @field_validator("worker")
    @classmethod
    def validate_worker(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ApprovalCreateRequest(BaseModel):
    action: str = Field(min_length=1)
    payload: dict = Field(default_factory=dict)
    requested_by: str = "mainagent"
    conversation_id: int | None = None
    note: str | None = None
    expires_in: int | None = Field(default=None, ge=1, le=86_400)
    # sha256 of the exact action+payload the approval is for. The execution layer verifies
    # this before running anything, so an approval can never authorise a different action.
    action_hash: str | None = Field(default=None, max_length=128)

    @field_validator("action", "requested_by")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ApprovalDecisionRequest(BaseModel):
    decided_by: str = "human"
    note: str | None = None

    @field_validator("decided_by")
    @classmethod
    def validate_decided_by(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ApprovalItem(BaseModel):
    id: int
    project_id: str | None = None
    conversation_id: int | None = None
    action: str
    payload: dict
    status: Literal["pending", "approved", "denied", "expired", "cancelled"]
    requested_by: str
    requested_at: str
    decided_by: str | None = None
    decided_at: str | None = None
    decision_note: str | None = None
    expires_at: str | None = None
    metadata: dict = Field(default_factory=dict)
    action_hash: str | None = None
    consumed_at: str | None = None
    consumed_by: str | None = None


class ApprovalConsumeRequest(BaseModel):
    consumed_by: str = "mainagent"
    # Required: the execution layer must prove *which* action it is burning. The server
    # compares this with the stored ``action_hash`` (fail-closed when either is absent).
    action_hash: str | None = Field(default=None, max_length=128)

    @field_validator("consumed_by")
    @classmethod
    def validate_consumed_by(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ApprovalPolicy(BaseModel):
    """Machine-readable statement of what the approval queue actually enforces."""

    rest_boundary: str
    enforcement: str
    enforced_by: list[str]
    gate_active: bool = False
    gated_actions: list[str] = Field(default_factory=list)
    gated_chat_tools: list[str] = Field(default_factory=list)
    single_use: bool
    action_binding: str
    tool_approvals: str
    worker_approvals: str
    transport_trust: str
    notes: list[str] = Field(default_factory=list)


class ApprovalList(BaseModel):
    items: list[ApprovalItem]
    pending: int


# ---------------------------------------------------------------- domain layer
# Generalized Artex objects: entities (assets), findings (claims), retests
# (verification replays). All are optional; the core fact/intent graph does not
# require them.

SEVERITIES = ("critical", "high", "medium", "low", "info")
FINDING_STATUSES = (
    "pending",
    "in_progress",
    "confirmed",
    "resolved",
    "fixed",
    "false_positive",
    "ignored",
    "duplicate",
    "risk_accepted",
)
RETEST_STATUSES = ("pending", "running", "completed", "failed", "stopped")
RETEST_VERDICTS = ("reproduced", "fixed", "inconclusive")


class Entity(BaseModel):
    id: str
    project_id: str
    kind: str
    key: str
    label: str = ""
    parent_id: str | None = None
    in_scope: bool = True
    status: str = "discovered"
    source: str = "worker"
    metadata: dict = Field(default_factory=dict)
    created_at: str
    last_seen_at: str
    fact_count: int = 0
    tested: bool = False


class CreateEntityRequest(BaseModel):
    kind: str = Field(min_length=1, max_length=64)
    key: str = Field(min_length=1, max_length=512)
    label: str = ""
    parent_id: str | None = None
    parent_key: str | None = None
    # None = keep the existing value (new entities default to in scope / discovered).
    in_scope: bool | None = None
    status: str | None = None
    source: str = "worker"
    metadata: dict = Field(default_factory=dict)
    facts: list[str] = Field(default_factory=list)
    intent_id: str | None = None


class CreateEntityBatchRequest(BaseModel):
    entities: list[CreateEntityRequest] = Field(min_length=1, max_length=500)


class UpdateEntityRequest(BaseModel):
    label: str | None = None
    parent_id: str | None = None
    in_scope: bool | None = None
    status: str | None = None
    metadata: dict | None = None


class Finding(BaseModel):
    id: str
    project_id: str
    fact_id: str | None = None
    intent_id: str | None = None
    entity_id: str | None = None
    title: str = ""
    klass: str = ""
    severity: str = ""
    summary: str = ""
    evidence: str = ""
    status: str = "pending"
    worker: str = ""
    metadata: dict = Field(default_factory=dict)
    report: str = ""
    created_at: str
    updated_at: str
    entity_ids: list[str] = Field(default_factory=list)
    retests: list[dict] = Field(default_factory=list)


class CreateFindingRequest(BaseModel):
    title: str = Field(min_length=1, max_length=512)
    klass: str = ""
    severity: str = ""
    summary: str = ""
    evidence: str = ""
    status: str = "pending"
    worker: str = ""
    fact_id: str | None = None
    intent_id: str | None = None
    entity_id: str | None = None
    entities: list[str] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)


class UpdateFindingRequest(BaseModel):
    title: str | None = None
    klass: str | None = None
    severity: str | None = None
    summary: str | None = None
    evidence: str | None = None
    status: str | None = None
    report: str | None = None
    metadata: dict | None = None


class Retest(BaseModel):
    id: str
    project_id: str
    finding_id: str
    intent_id: str | None = None
    run_id: str | None = None
    status: str = "pending"
    verdict: str = ""
    notes: str = ""
    snapshot: dict = Field(default_factory=dict)
    summary: str = ""
    evidence: str = ""
    error: str = ""
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None


class CreateRetestRequest(BaseModel):
    notes: str = ""
    worker: str = "human"


class RetestResultRequest(BaseModel):
    verdict: str = ""
    summary: str = ""
    evidence: str = ""
    notes: str = ""
    status: str = "completed"


class CoverageByKind(BaseModel):
    kind: str
    total: int
    tested: int


class Coverage(BaseModel):
    enabled: bool = True
    scope_rows: int = 0
    denominator: int = 0
    tested: int = 0
    pct: float | None = None
    by_kind: list[CoverageByKind] = Field(default_factory=list)
    untested: list[dict] = Field(default_factory=list)


class CoverageGraphNode(BaseModel):
    key: str
    id: str | None = None
    kind: str
    label: str
    tested: bool = False
    in_scope: bool = True
    parent_id: str | None = None


class CoverageGraphEdge(BaseModel):
    src: str
    dst: str


class CoverageGraphData(BaseModel):
    nodes: list[CoverageGraphNode] = Field(default_factory=list)
    edges: list[CoverageGraphEdge] = Field(default_factory=list)
