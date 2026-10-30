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
    transcript_truncated: bool = False
    counts: WorkerRunCounts = Field(default_factory=WorkerRunCounts)
    transcript: list[ProjectActivityItem] = Field(default_factory=list)


class WorkerRunList(BaseModel):
    items: list[WorkerRunItem]
    project_id: str
    generated_at: str
    active_count: int = 0


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
