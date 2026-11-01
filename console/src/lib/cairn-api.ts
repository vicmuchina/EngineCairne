/**
 * Minimal Cairn API client for the forked Artex UI.
 *
 * Every request goes through the same-origin `/api` proxy that next.config.mjs
 * rewrites to the Cairn backend (http://127.0.0.1:8000, prefix stripped).
 * Nothing here touches the Artex Go backend or its mock layer.
 *
 * Types are deliberately small and local to this fork: do not import Artex's
 * lib/types.ts into Cairn pages.
 */

export const CAIRN_PROXY_BASE = "/api";
/** Used only when a request is issued during SSR, where a relative URL is invalid. */
export const CAIRN_ORIGIN = process.env.NEXT_PUBLIC_CAIRN_ORIGIN ?? "http://127.0.0.1:8000";

// ── types ────────────────────────────────────────────────────────────────────

export type ProjectStatus = "active" | "stopped" | "completed";

export interface ProjectReason {
  worker: string;
  trigger: string;
  started_at: string;
  last_heartbeat_at: string;
}

export interface ProjectMeta {
  id: string;
  title: string;
  status: ProjectStatus;
  bootstrap_enabled: boolean;
  created_at: string;
  reason?: ProjectReason | null;
}

export interface ProjectSummary extends ProjectMeta {
  fact_count: number;
  intent_count: number;
  working_intent_count: number;
  unclaimed_intent_count: number;
  hint_count: number;
}

export interface Fact {
  id: string;
  description: string;
}

export interface Intent {
  id: string;
  from: string[];
  to?: string | null;
  description: string;
  creator: string;
  worker?: string | null;
  last_heartbeat_at?: string | null;
  created_at: string;
  concluded_at?: string | null;
}

export interface Hint {
  id: string;
  content: string;
  creator: string;
  created_at: string;
}

/**
 * Generalized Artex domain records. Entity kinds are free strings, so the UI
 * must never assume a fixed enum: known kinds get an icon, everything else a
 * hashed colour and a generic icon.
 */
export interface Entity {
  id: string;
  project_id?: string;
  kind: string;
  key: string;
  label: string;
  parent_id: string | null;
  in_scope: boolean;
  status: string;
  source: string;
  metadata: Record<string, unknown>;
  created_at: string;
  last_seen_at: string;
  fact_count: number;
  /** Anchored to a fact or a concluded intent. */
  tested: boolean;
  /** Forward-compatible: newer engines may inline the linked fact ids. */
  facts?: string[];
}

export interface Retest {
  id: string;
  project_id?: string;
  finding_id: string;
  intent_id?: string | null;
  run_id?: string | null;
  status: string;
  verdict: string;
  notes?: string;
  snapshot?: Record<string, unknown>;
  summary: string;
  evidence: string;
  error?: string;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface Finding {
  id: string;
  project_id?: string;
  fact_id: string | null;
  intent_id: string | null;
  entity_id: string | null;
  entity_ids: string[];
  title: string;
  klass: string;
  severity: string;
  summary: string;
  evidence: string;
  status: string;
  worker: string;
  metadata: Record<string, unknown>;
  report: string;
  created_at: string;
  updated_at: string;
  retests: Array<Pick<Retest, "id" | "status" | "verdict" | "created_at" | "finished_at">>;
}

export interface CoverageByKind {
  kind: string;
  total: number;
  tested: number;
}

export interface CoverageUntestedEntity {
  id: string;
  kind: string;
  key: string;
  label: string;
  in_scope: boolean;
}

export interface Coverage {
  enabled: boolean;
  scope_rows: number;
  denominator: number;
  tested: number;
  /** Fraction in [0, 1], or null when the denominator is zero. */
  pct: number | null;
  by_kind: CoverageByKind[];
  untested: CoverageUntestedEntity[];
}

export interface CoverageGraphNode {
  /** Stable React Flow id (`e:<entity id>`). */
  key: string;
  id: string | null;
  kind: string;
  label: string;
  tested: boolean;
  in_scope: boolean;
  parent_id: string | null;
}

export interface CoverageGraphEdge {
  src: string;
  dst: string;
}

export interface CoverageGraphData {
  nodes: CoverageGraphNode[];
  edges: CoverageGraphEdge[];
}

export interface EntityInput {
  kind: string;
  key: string;
  label?: string;
  parent_id?: string | null;
  parent_key?: string | null;
  in_scope?: boolean | null;
  status?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
  facts?: string[];
  intent_id?: string | null;
}

export interface EntityPatch {
  label?: string;
  parent_id?: string | null;
  in_scope?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface FindingInput {
  title: string;
  klass?: string;
  severity?: string;
  summary?: string;
  evidence?: string;
  status?: string;
  worker?: string;
  fact_id?: string | null;
  intent_id?: string | null;
  entity_id?: string | null;
  entities?: string[];
  metadata?: Record<string, unknown>;
}

export interface FindingPatch {
  title?: string;
  klass?: string;
  severity?: string;
  summary?: string;
  evidence?: string;
  status?: string;
  report?: string;
  metadata?: Record<string, unknown>;
}

export interface RetestInput {
  notes?: string;
  worker?: string;
}

export interface RetestPatch {
  verdict?: string;
  summary?: string;
  evidence?: string;
  notes?: string;
  status?: string;
}

export interface ProjectDetail {
  project: ProjectMeta;
  facts: Fact[];
  intents: Intent[];
  hints: Hint[];
  /** Optional so an older Cairn engine still renders the existing tabs. */
  entities?: Entity[];
  findings?: Finding[];
  retests?: Retest[];
  coverage?: Coverage | null;
}

/** Fills the additive domain fields so callers never branch on engine age. */
export function normalizeProjectDetail(detail: ProjectDetail): ProjectDetail {
  return {
    ...detail,
    entities: detail.entities ?? [],
    findings: detail.findings ?? [],
    retests: detail.retests ?? [],
    coverage: detail.coverage ?? null,
  };
}

export interface CairnSettings {
  intent_timeout: number;
  reason_timeout: number;
}

export type ConversationStatus = "idle" | "running" | "error";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type MessageStatus = "done" | "running" | "error" | "stopped";

export interface ChatConversation {
  id: number;
  project_id: string;
  title: string;
  status: ConversationStatus;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  activity_count?: number;
}

export interface ChatMessage {
  id: number;
  seq: number;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  error?: string | null;
  created_at: string;
  run_id?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
}

export interface ChatActivity {
  id: number;
  conversation_id: number;
  message_id?: number | null;
  run_id?: string | null;
  seq: number;
  kind: string;
  role?: string | null;
  content?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  tool_input?: string | null;
  tool_output?: string | null;
  status: string;
  error?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  created_at: string;
  raw?: string | null;
}

export interface ChatActivityList {
  items: ChatActivity[];
  next_after_seq: number;
  has_more: boolean;
  conversation_id: number;
}

/** One row of GET /projects/{id}/activity (facts, intents, hints, tool/chat/approval events). */
export interface ProjectActivityItem {
  kind: string;
  id: string;
  project_id: string;
  timestamp: string | null;
  timestamp_source: string;
  actor: string | null;
  status: string | null;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  source: string;
  cursor: string | null;
  /** Worker transcript rows only: the dispatcher run that emitted the row. */
  run_id?: string | null;
}

export interface WorkerRunCounts {
  activities: number;
  thinking: number;
  tool_calls: number;
  tool_results: number;
  messages: number;
  errors: number;
}

/** One dispatcher worker run from GET /projects/{id}/workers. */
export interface WorkerRunItem {
  run_id: string;
  project_id: string;
  worker: string;
  task?: string | null;
  intent_id?: string | null;
  intent_description?: string | null;
  status: string;
  active: boolean;
  stale: boolean;
  started_at?: string | null;
  finished_at?: string | null;
  last_event_at?: string | null;
  duration_ms?: number | null;
  error?: string | null;
  session?: string | null;
  transcript_truncated: boolean;
  counts: WorkerRunCounts;
  transcript: ProjectActivityItem[];
}

export interface WorkerRunList {
  items: WorkerRunItem[];
  project_id: string;
  generated_at: string;
  active_count: number;
}

export interface ProjectActivityFeed {
  items: ProjectActivityItem[];
  next_cursor: string | null;
  has_more: boolean;
  project_id: string;
}

export interface ProjectWorker {
  name: string;
  intent_id: string;
  last_heartbeat_at: string | null;
}

export interface ProjectOverview {
  project: ProjectMeta;
  project_id: string;
  generated_at: string;
  counts: Record<string, number>;
  workers: ProjectWorker[];
  recent_activity: ProjectActivityItem[];
}

export interface ProjectReportCounts {
  facts?: number;
  findings?: number;
  open_intents?: number;
  completed_intents?: number;
  work_runs?: number;
  tool_calls?: number;
  messages?: number;
  wall_clock_ms?: number | null;
  hints?: number;
  tokens?: { input?: number; cache_read?: number; output?: number };
}

/** GET /projects/{id}/report — deterministic Markdown report + counts. */
export interface ProjectReport {
  project_id?: string;
  generated_at?: string;
  markdown: string;
  counts?: ProjectReportCounts | null;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalItem {
  id: number;
  project_id: string | null;
  conversation_id: number | null;
  action: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown>;
}

export interface ApprovalList {
  items: ApprovalItem[];
  pending: number;
}

export interface SteerResponse {
  accepted: boolean;
  conversation_id: number;
  run_id?: string | null;
  disposition?: string | null;
  activity_id?: number | null;
  detail?: string | null;
}

// ── error type ───────────────────────────────────────────────────────────────

export class CairnApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail: string;

  constructor(status: number, path: string, detail: string) {
    super(`Cairn API ${status} on ${path}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
    this.name = "CairnApiError";
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

// ── transport ────────────────────────────────────────────────────────────────

function baseUrl(): string {
  // Browser: same-origin proxy. Node (SSR): absolute Cairn origin.
  return typeof window === "undefined" ? CAIRN_ORIGIN : CAIRN_PROXY_BASE;
}

async function cairnFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, { ...init, headers, cache: "no-store" });
  } catch (cause) {
    throw new Error(`Cairn API unreachable (${path}): ${(cause as Error).message}`, { cause });
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      /* body already consumed/unavailable */
    }
    throw new CairnApiError(response.status, path, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}

/**
 * Low-level GET for feature adapters that need their own tolerant fallback
 * (e.g. the Artex-shaped sessions view). Returns the decoded JSON body.
 */
export function cairnGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return cairnFetch<T>(path, { signal });
}

async function cairnFetchText(path: string, init?: RequestInit): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, { ...init, cache: "no-store" });
  } catch (cause) {
    throw new Error(`Cairn API unreachable (${path}): ${(cause as Error).message}`, { cause });
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      /* unavailable */
    }
    throw new CairnApiError(response.status, path, detail);
  }
  return response.text();
}

// ── endpoints ────────────────────────────────────────────────────────────────

export const cairn = {
  /** GET /projects — project summaries including fact/intent counts. */
  listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    return cairnFetch<ProjectSummary[]>("/projects", { signal });
  },

  /** GET /projects/{id} — project meta plus facts, intents, hints and domain rows. */
  async getProject(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
    const detail = await cairnFetch<ProjectDetail>(`/projects/${encodeURIComponent(id)}`, { signal });
    return normalizeProjectDetail(detail);
  },

  /** GET /projects/{id}/entities — entity records, optionally filtered server-side. */
  listEntities(
    id: string,
    opts: { kind?: string; inScope?: boolean; tested?: boolean; q?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Entity[]> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 500) });
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.inScope !== undefined) params.set("in_scope", String(opts.inScope));
    if (opts.tested !== undefined) params.set("tested", String(opts.tested));
    if (opts.q) params.set("q", opts.q);
    return cairnFetch<Entity[]>(`/projects/${encodeURIComponent(id)}/entities?${params.toString()}`, {
      signal: opts.signal,
    });
  },

  /** POST /projects/{id}/entity — single-entity write-back. */
  upsertEntity(id: string, input: EntityInput): Promise<Entity> {
    return cairnFetch<Entity>(`/projects/${encodeURIComponent(id)}/entity`, {
      ...jsonBody(input),
      method: "POST",
    });
  },

  /** PATCH /projects/{id}/entities/{entityId}. */
  patchEntity(id: string, entityId: string, patch: EntityPatch): Promise<Entity> {
    return cairnFetch<Entity>(`/projects/${encodeURIComponent(id)}/entities/${encodeURIComponent(entityId)}`, {
      ...jsonBody(patch),
      method: "PATCH",
    });
  },

  /** GET /projects/{id}/findings. */
  listFindings(
    id: string,
    opts: {
      status?: string;
      severity?: string;
      entityId?: string;
      q?: string;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Finding[]> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 500) });
    if (opts.status) params.set("status", opts.status);
    if (opts.severity) params.set("severity", opts.severity);
    if (opts.entityId) params.set("entity_id", opts.entityId);
    if (opts.q) params.set("q", opts.q);
    return cairnFetch<Finding[]>(`/projects/${encodeURIComponent(id)}/findings?${params.toString()}`, {
      signal: opts.signal,
    });
  },

  /** POST /projects/{id}/findings. */
  createFinding(id: string, input: FindingInput): Promise<Finding> {
    return cairnFetch<Finding>(`/projects/${encodeURIComponent(id)}/findings`, {
      ...jsonBody(input),
      method: "POST",
    });
  },

  /** PATCH /projects/{id}/findings/{findingId}. */
  patchFinding(id: string, findingId: string, patch: FindingPatch): Promise<Finding> {
    return cairnFetch<Finding>(`/projects/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}`, {
      ...jsonBody(patch),
      method: "PATCH",
    });
  },

  /** GET /projects/{id}/retests. */
  listRetests(
    id: string,
    opts: { findingId?: string; status?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Retest[]> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 500) });
    if (opts.findingId) params.set("finding_id", opts.findingId);
    if (opts.status) params.set("status", opts.status);
    return cairnFetch<Retest[]>(`/projects/${encodeURIComponent(id)}/retests?${params.toString()}`, {
      signal: opts.signal,
    });
  },

  /** POST /projects/{id}/findings/{findingId}/retests. */
  createRetest(id: string, findingId: string, input: RetestInput = {}): Promise<Retest> {
    return cairnFetch<Retest>(`/projects/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}/retests`, {
      ...jsonBody(input),
      method: "POST",
    });
  },

  /** PATCH /projects/{id}/retests/{retestId}. */
  patchRetest(id: string, retestId: string, patch: RetestPatch): Promise<Retest> {
    return cairnFetch<Retest>(`/projects/${encodeURIComponent(id)}/retests/${encodeURIComponent(retestId)}`, {
      ...jsonBody(patch),
      method: "PATCH",
    });
  },

  /** GET /projects/{id}/coverage — denominator, tested count and per-kind rows. */
  getCoverage(id: string, untestedLimit = 20, signal?: AbortSignal): Promise<Coverage> {
    return cairnFetch<Coverage>(`/projects/${encodeURIComponent(id)}/coverage?untested_limit=${untestedLimit}`, {
      signal,
    });
  },

  /** GET /projects/{id}/coverage/graph — entity containment (parent → child). */
  getCoverageGraph(id: string, signal?: AbortSignal): Promise<CoverageGraphData> {
    return cairnFetch<CoverageGraphData>(`/projects/${encodeURIComponent(id)}/coverage/graph`, { signal });
  },

  /** PUT /projects/{id}/status — pause (stopped) or resume (active). */
  updateProjectStatus(id: string, status: "active" | "stopped"): Promise<ProjectMeta> {
    return cairnFetch<ProjectMeta>(`/projects/${encodeURIComponent(id)}/status`, {
      ...jsonBody({ status }),
      method: "PUT",
    });
  },

  /** Same-origin export path; the backend serves text/plain for yaml and timeline. */
  exportPath(id: string, format: "yaml" | "timeline"): string {
    return `${CAIRN_PROXY_BASE}/projects/${encodeURIComponent(id)}/export?format=${format}`;
  },

  /** Readable export text for the Report preview. */
  getExportText(id: string, format: "yaml" | "timeline", signal?: AbortSignal): Promise<string> {
    return cairnFetchText(`/projects/${encodeURIComponent(id)}/export?format=${format}`, { signal });
  },

  /** GET /projects/{id}/activity — unified feed (facts, intents, hints, events, chat). */
  getProjectActivity(
    id: string,
    opts: {
      limit?: number;
      kinds?: string[];
      after?: string;
      before?: string;
      newestFirst?: boolean;
      compact?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<ProjectActivityFeed> {
    const params = new URLSearchParams();
    params.set("limit", String(opts.limit ?? 200));
    if (opts.kinds?.length) params.set("kinds", opts.kinds.join(","));
    if (opts.after) params.set("after", opts.after);
    if (opts.before) params.set("before", opts.before);
    if (opts.newestFirst) params.set("newest_first", "true");
    if (opts.compact) params.set("compact", "true");
    return cairnFetch<ProjectActivityFeed>(`/projects/${encodeURIComponent(id)}/activity?${params.toString()}`, {
      signal: opts.signal,
    });
  },

  /** GET /projects/{id}/overview — counts, workers and recent activity. */
  getProjectOverview(id: string, signal?: AbortSignal): Promise<ProjectOverview> {
    return cairnFetch<ProjectOverview>(`/projects/${encodeURIComponent(id)}/overview`, { signal });
  },

  /** GET /projects/{id}/report — deterministic Markdown report (sessions v2). */
  getProjectReport(id: string, signal?: AbortSignal): Promise<ProjectReport> {
    return cairnFetch<ProjectReport>(`/projects/${encodeURIComponent(id)}/report`, { signal });
  },

  /**
   * GET /projects/{id}/workers — live/recent dispatcher worker runs. Each item
   * carries its transcript in emission order (never re-sorted by the client).
   */
  listProjectWorkers(
    id: string,
    opts: {
      worker?: string;
      runId?: string;
      activeOnly?: boolean;
      includeTranscript?: boolean;
      limit?: number;
      transcriptLimit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<WorkerRunList> {
    const params = new URLSearchParams({
      limit: String(opts.limit ?? 20),
      transcript_limit: String(opts.transcriptLimit ?? 200),
      include_transcript: String(opts.includeTranscript ?? true),
    });
    if (opts.worker) params.set("worker", opts.worker);
    if (opts.runId) params.set("run_id", opts.runId);
    if (opts.activeOnly) params.set("active_only", "true");
    return cairnFetch<WorkerRunList>(`/projects/${encodeURIComponent(id)}/workers?${params.toString()}`, {
      signal: opts.signal,
    });
  },

  /** GET /settings — dispatcher timeouts. */
  getSettings(signal?: AbortSignal): Promise<CairnSettings> {
    return cairnFetch<CairnSettings>("/settings", { signal });
  },

  listConversations(projectId?: string, signal?: AbortSignal): Promise<{ items: ChatConversation[] }> {
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return cairnFetch<{ items: ChatConversation[] }>(`/chat/conversations${query}`, { signal });
  },

  createConversation(projectId: string, title?: string): Promise<ChatConversation> {
    return cairnFetch<ChatConversation>("/chat/conversations", {
      ...jsonBody({ project_id: projectId, title }),
      method: "POST",
    });
  },

  listMessages(conversationId: number, signal?: AbortSignal): Promise<{ items: ChatMessage[] }> {
    return cairnFetch<{ items: ChatMessage[] }>(`/chat/conversations/${conversationId}/messages`, { signal });
  },

  sendMessage(
    conversationId: number,
    message: string,
    signal?: AbortSignal,
  ): Promise<{ items: ChatMessage[]; conversation: ChatConversation }> {
    return cairnFetch<{ items: ChatMessage[]; conversation: ChatConversation }>(
      `/chat/conversations/${conversationId}/messages`,
      { ...jsonBody({ message }), method: "POST", signal },
    );
  },

  /** GET /chat/conversations/{id}/activities — incrementally pollable pi trace. */
  listChatActivities(conversationId: number, afterSeq = 0, signal?: AbortSignal): Promise<ChatActivityList> {
    return cairnFetch<ChatActivityList>(
      `/chat/conversations/${conversationId}/activities?limit=500&after_seq=${afterSeq}`,
      { signal },
    );
  },

  /** POST /chat/conversations/{id}/steer — deliver a live mid-turn steer. */
  steerConversation(conversationId: number, message: string): Promise<SteerResponse> {
    return cairnFetch<SteerResponse>(`/chat/conversations/${conversationId}/steer`, {
      ...jsonBody({ message }),
      method: "POST",
    });
  },

  /** POST /chat/conversations/{id}/stop — stop the in-flight pi turn. */
  stopConversation(
    conversationId: number,
  ): Promise<{ stopped: boolean; reconciled: boolean; conversation: ChatConversation }> {
    return cairnFetch<{ stopped: boolean; reconciled: boolean; conversation: ChatConversation }>(
      `/chat/conversations/${conversationId}/stop`,
      { method: "POST" },
    );
  },

  /** DELETE /chat/conversations/{id}. */
  async deleteConversation(conversationId: number): Promise<void> {
    await cairnFetch<void>(`/chat/conversations/${conversationId}`, { method: "DELETE" });
  },

  /** GET /approvals — cross-project approval queue. */
  listApprovals(status?: ApprovalStatus | "all", signal?: AbortSignal): Promise<ApprovalList> {
    const params = new URLSearchParams({ limit: "200" });
    if (status && status !== "all") params.set("status", status);
    return cairnFetch<ApprovalList>(`/approvals?${params.toString()}`, { signal });
  },

  /** GET /projects/{id}/approvals — project-scoped approval queue. */
  listProjectApprovals(
    projectId: string,
    status?: ApprovalStatus | "all",
    signal?: AbortSignal,
  ): Promise<ApprovalList> {
    const params = new URLSearchParams({ limit: "200" });
    if (status && status !== "all") params.set("status", status);
    return cairnFetch<ApprovalList>(`/projects/${encodeURIComponent(projectId)}/approvals?${params.toString()}`, {
      signal,
    });
  },

  approveApproval(id: number, note?: string): Promise<ApprovalItem> {
    return cairnFetch<ApprovalItem>(`/approvals/${id}/approve`, {
      ...jsonBody({ decided_by: "local", note }),
      method: "POST",
    });
  },

  denyApproval(id: number, note?: string): Promise<ApprovalItem> {
    return cairnFetch<ApprovalItem>(`/approvals/${id}/deny`, {
      ...jsonBody({ decided_by: "local", note }),
      method: "POST",
    });
  },
};

// ── derived helpers (pure, shared by pages) ──────────────────────────────────

export type CairnIntentState = "working" | "unclaimed" | "concluded";

/** Cairn has no intent status column: state is derived from worker/concluded_at. */
export function intentState(intent: Intent): CairnIntentState {
  if (intent.concluded_at) return "concluded";
  if (intent.worker) return "working";
  return "unclaimed";
}

/** Cairn seeds every project with two premise facts: origin and goal. */
export const PREMISE_FACT_IDS = ["origin", "goal"] as const;

/** Findings = facts minus the origin/goal premises (the Alpine UI counts facts). */
export function findingCount(project: Pick<ProjectSummary, "fact_count">): number {
  return Math.max(0, project.fact_count - PREMISE_FACT_IDS.length);
}

export interface ProjectTotals {
  projects: number;
  active: number;
  stopped: number;
  completed: number;
  facts: number;
  intents: number;
  open: number;
  working: number;
  unclaimed: number;
  concluded: number;
  hints: number;
}

export function projectTotals(projects: readonly ProjectSummary[]): ProjectTotals {
  const totals: ProjectTotals = {
    projects: projects.length,
    active: 0,
    stopped: 0,
    completed: 0,
    facts: 0,
    intents: 0,
    open: 0,
    working: 0,
    unclaimed: 0,
    concluded: 0,
    hints: 0,
  };
  for (const project of projects) {
    totals[project.status] += 1;
    totals.facts += findingCount(project);
    totals.intents += project.intent_count;
    totals.working += project.working_intent_count;
    totals.unclaimed += project.unclaimed_intent_count;
    totals.open += project.working_intent_count + project.unclaimed_intent_count;
    totals.concluded += Math.max(
      0,
      project.intent_count - project.working_intent_count - project.unclaimed_intent_count,
    );
    totals.hints += project.hint_count;
  }
  return totals;
}
