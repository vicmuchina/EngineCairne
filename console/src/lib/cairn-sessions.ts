/**
 * Artex-shaped sessions data layer for Cairn.
 *
 * Primary source: GET /projects/{id}/sessions and
 * GET /projects/{id}/sessions/{key}/activities (see the sessions API contract).
 * The endpoints are being built in parallel with the UI, so every read also has
 * a tolerant fallback that synthesizes the same shape from the endpoints that
 * already exist:
 *
 *   sessions     <- /projects/{id}/workers + /chat/conversations?project_id=
 *   main         <- the newest chat conversation + its activities
 *   planner      <- the newest task=reason worker run transcript
 *   worker:<id>  <- that worker run's transcript
 *   system audit <- /projects/{id}/activity status/project/import/error rows
 *
 * The fallback never invents transcript rows: every row comes from one of those
 * real Cairn endpoints. Polling (1 s) is the only transport; no SSE required.
 */

import {
  CairnApiError,
  type ChatActivity,
  type ChatConversation,
  cairn,
  cairnGet,
  type ProjectActivityItem,
  type WorkerRunItem,
} from "./cairn-api";

// ── contract types (kept local to the fork) ─────────────────────────────────

export type CairnSessionRole = "mainagent" | "planner" | "system" | "worker";

export interface SessionTokens {
  input: number;
  cache_read: number;
  output: number;
  cost: number;
}

export interface SessionInterruption {
  reason?: string | null;
  terminal_state?: string | null;
  turns?: number | null;
  duration_ms?: number | null;
  usage?: { input?: number; output?: number; cache_read?: number } | null;
  tool?: { name?: string | null; call_id?: string | null; input?: string | null } | null;
  text?: string | null;
  run_id?: string | null;
}

export interface SessionSummary {
  kind?: "intents" | "complete" | "none" | "interrupted" | string;
  description?: string | null;
  intents?: Array<{ from?: string[]; description?: string }>;
  count?: number;
  interruption?: SessionInterruption | null;
}

/** One execute/conclude dispatcher phase inside a merged worker session. */
export interface SessionRun {
  run_id: string;
  task?: string | null;
  status?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  usage?: { input?: number; output?: number; cache_read?: number; total_tokens?: number; cost?: number } | null;
  model?: string | null;
}

export interface CairnSession {
  key: string;
  role: CairnSessionRole | string;
  title: string;
  status: string;
  live: boolean;
  stale?: boolean;
  last_activity_at?: string | null;
  unread?: number;
  tokens?: Partial<SessionTokens> | null;
  run_id?: string | null;
  worker?: string | null;
  task?: string | null;
  intent_id?: string | null;
  intent_description?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  counts?: Record<string, number> | null;
  model?: string | null;
  usage?: Record<string, number> | null;
  /** Sessions v2: queued intents waiting for a worker slot (no transcript). */
  queued?: boolean;
  interrupted?: boolean;
  interrupt_reason?: string | null;
  /** Merged worker phase status. The backend has shipped both names. */
  phases?: { execute?: string | null; conclude?: string | null } | null;
  phase_status?: { execute?: string | null; conclude?: string | null } | null;
  runs?: SessionRun[];
  /** Planner round + normalized round summary. */
  round?: number | null;
  summary?: SessionSummary | null;
  summary_text?: string | null;
  /** UI-only: extra session keys when an old backend split execute/conclude rows. */
  merged_keys?: string[];
}

export interface CairnSessionList {
  project_id: string;
  generated_at: string;
  project_status: string;
  task_total: SessionTokens;
  sessions: CairnSession[];
  /** True when /sessions 404'd and the rail was rebuilt from older endpoints. */
  fallback?: boolean;
}

export interface SessionActivityTool {
  name?: string | null;
  call_id?: string | null;
  input?: string | null;
  output?: string | null;
  duration_ms?: number | null;
  is_error?: boolean;
}

export interface SessionActivityTokens {
  input?: number;
  output?: number;
  cache_read?: number;
}

export interface SessionActivity {
  seq: number;
  id: number | string;
  kind: string;
  role?: string | null;
  status?: string | null;
  content?: string | null;
  tool?: SessionActivityTool | null;
  tokens?: SessionActivityTokens | null;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface SessionActivityPage {
  key: string;
  items: SessionActivity[];
  has_more: boolean;
  earliest_seq: number | null;
}

export interface MainSendResult {
  conversation: ChatConversation;
  items: unknown;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const PAGE_LIMIT = 200;
const MISSING_RETRY_MS = 60_000;

// Once /sessions 404s (older backend during the parallel rollout), stop hammering
// it every second: retry the new endpoint after a minute and use the existing
// Cairn endpoints in between. This also keeps the browser network log quiet.
const missingSessionsUntil = new Map<string, number>();

function sessionsEndpointMissing(projectId: string): boolean {
  const until = missingSessionsUntil.get(projectId);
  return until !== undefined && Date.now() < until;
}

function markSessionsEndpointMissing(projectId: string): void {
  missingSessionsUntil.set(projectId, Date.now() + MISSING_RETRY_MS);
}

function isMissingEndpoint(cause: unknown): boolean {
  if (cause instanceof CairnApiError) return cause.status === 404 || cause.status === 405 || cause.status === 501;
  const message = (cause as Error)?.message ?? "";
  return /\b(404|405|501)\b|not found/i.test(message);
}

function emptyTokens(): SessionTokens {
  return { input: 0, cache_read: 0, output: 0, cost: 0 };
}

export function sessionTokens(session: CairnSession | null | undefined): SessionTokens {
  const tokens = session?.tokens ?? {};
  return {
    input: Number(tokens.input ?? 0) || 0,
    cache_read: Number(tokens.cache_read ?? 0) || 0,
    output: Number(tokens.output ?? 0) || 0,
    cost: Number(tokens.cost ?? 0) || 0,
  };
}

function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function isConcludePhase(session: CairnSession): boolean {
  const phases = session.phases ?? session.phase_status;
  if (phases?.conclude && !phases.execute) return true;
  return /_conclude$/.test(session.task ?? "");
}

function addSessionTokens(total: Partial<SessionTokens>, session: CairnSession): Partial<SessionTokens> {
  const tokens = sessionTokens(session);
  return {
    input: Number(total.input ?? 0) + tokens.input,
    cache_read: Number(total.cache_read ?? 0) + tokens.cache_read,
    output: Number(total.output ?? 0) + tokens.output,
    cost: Number(total.cost ?? 0) + tokens.cost,
  };
}

/**
 * Sessions v2 merges a worker's execute and conclude runs into one row keyed by
 * intent_id. Older backends still return two rows (`explore` + `explore_conclude`).
 * Collapse those locally so the rail and transcript show one row per intent; the
 * extra keys are kept so the activity loader can merge both transcripts.
 */
export function collapseWorkerSessions(sessions: readonly CairnSession[]): CairnSession[] {
  const standalone: CairnSession[] = [];
  const groups = new Map<string, CairnSession[]>();
  for (const session of sessions) {
    if (session.role !== "worker") continue;
    if (!session.intent_id) {
      standalone.push(session);
      continue;
    }
    const group = groups.get(session.intent_id) ?? [];
    group.push(session);
    groups.set(session.intent_id, group);
  }

  const collapsed: CairnSession[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      collapsed.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      const at = parseTime(a.started_at ?? a.last_activity_at);
      const bt = parseTime(b.started_at ?? b.last_activity_at);
      return at === bt ? a.key.localeCompare(b.key) : at - bt;
    });
    const execute = sorted.find((session) => !isConcludePhase(session)) ?? sorted[0];
    const conclude = [...sorted].reverse().find(isConcludePhase);
    const last = [...sorted].sort((a, b) => {
      const at = parseTime(a.finished_at ?? a.last_activity_at);
      const bt = parseTime(b.finished_at ?? b.last_activity_at);
      return bt - at;
    })[0];
    const startedAt = sorted
      .map((session) => session.started_at)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => parseTime(a) - parseTime(b))[0];
    const finishedAt = sorted
      .map((session) => session.finished_at)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => parseTime(b) - parseTime(a))[0];
    const tokens = sorted.reduce<Partial<SessionTokens>>(
      (total, session) => addSessionTokens(total, session),
      { input: 0, cache_read: 0, output: 0, cost: 0 },
    );
    const counts: Record<string, number> = {};
    for (const session of sorted) {
      for (const [key, value] of Object.entries(session.counts ?? {})) {
        if (typeof value === "number") counts[key] = (counts[key] ?? 0) + value;
      }
    }
    const live = sorted.some((session) => session.live);
    const succeeded = conclude?.status === "success";
    const interrupted = !succeeded && sorted.some((session) => session.interrupted);
    const interruptReason = sorted.find((session) => session.interrupt_reason)?.interrupt_reason ?? null;
    const durations = sorted
      .map((session) => session.duration_ms)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const durationMs = durations.length
      ? durations.reduce((total, value) => total + value, 0)
      : startedAt && finishedAt
        ? Math.max(0, parseTime(finishedAt) - parseTime(startedAt))
        : null;
    collapsed.push({
      ...execute,
      key: execute.key,
      title: execute.title,
      status: live ? "running" : succeeded ? "success" : (last.status ?? execute.status),
      live,
      queued: false,
      stale: sorted.every((session) => session.stale),
      last_activity_at: last.last_activity_at ?? execute.last_activity_at ?? null,
      started_at: startedAt ?? execute.started_at ?? null,
      finished_at: finishedAt ?? last.finished_at ?? null,
      duration_ms: durationMs,
      tokens,
      counts,
      runs: sorted.flatMap((session) => session.runs ?? []),
      phases: {
        execute: execute.phases?.execute ?? execute.phase_status?.execute ?? null,
        conclude: conclude?.phases?.conclude ?? conclude?.phase_status?.conclude ?? null,
      },
      interrupted,
      interrupt_reason: interruptReason,
      merged_keys: sorted.map((session) => session.key),
    });
  }
  return [...standalone, ...collapsed];
}

/** live first, queued next, finished last (stable inside each bucket). */
export function orderWorkerSessions(sessions: readonly CairnSession[]): CairnSession[] {
  const rank = (session: CairnSession) => (session.live ? 0 : session.queued ? 1 : 2);
  return [...sessions].sort((a, b) => {
    const delta = rank(a) - rank(b);
    if (delta !== 0) return delta;
    if (a.queued && b.queued) return 0;
    return parseTime(b.last_activity_at ?? b.started_at) - parseTime(a.last_activity_at ?? a.started_at);
  });
}

function newestConversation(items: readonly ChatConversation[]): ChatConversation | null {
  let newest: ChatConversation | null = null;
  for (const item of items) {
    if (!newest) {
      newest = item;
      continue;
    }
    const delta = parseTime(item.updated_at) - parseTime(newest.updated_at);
    if (delta > 0 || (delta === 0 && item.id > newest.id)) newest = item;
  }
  return newest;
}

/** The main session is the newest project conversation on the Cairn backend. */
export async function findMainConversation(projectId: string, signal?: AbortSignal): Promise<ChatConversation | null> {
  const { items } = await cairn.listConversations(projectId, signal);
  return newestConversation(items);
}

/** Newest task=reason run (the planner lane). */
function newestReasonRun(items: readonly WorkerRunItem[]): WorkerRunItem | null {
  let newest: WorkerRunItem | null = null;
  let newestTs = 0;
  for (const item of items) {
    if (item.task !== "reason") continue;
    const ts = parseTime(item.last_event_at ?? item.finished_at ?? item.started_at);
    if (!newest || ts > newestTs) {
      newest = item;
      newestTs = ts;
    }
  }
  return newest;
}

function mainTitle(conversation: ChatConversation | null): string {
  if (!conversation) return "Main agent - conversation #1";
  const title = conversation.title.trim();
  if (!title || title.toLowerCase() === "new conversation") {
    return `Main agent - conversation #${conversation.id}`;
  }
  return `Main agent - ${title}`;
}

function workerSeverity(item: WorkerRunItem): number {
  // Newest first in the rail: last event wins, then run start.
  return parseTime(item.last_event_at ?? item.finished_at ?? item.started_at);
}

function workerSession(item: WorkerRunItem): CairnSession {
  const description = item.intent_description?.trim() || item.task?.trim() || item.intent_id?.trim() || "worker";
  const shortRun = item.run_id.slice(0, 8);
  return {
    key: `worker:${item.run_id}`,
    role: "worker",
    title: `#${shortRun} ${description}`,
    status: item.stale ? "stale" : item.status,
    live: Boolean(item.active),
    last_activity_at: item.last_event_at ?? item.finished_at ?? item.started_at ?? null,
    tokens: emptyTokens(),
    run_id: item.run_id,
    worker: item.worker,
    task: item.task ?? null,
    intent_id: item.intent_id ?? null,
    stale: Boolean(item.stale),
    started_at: item.started_at ?? null,
    finished_at: item.finished_at ?? null,
    duration_ms: item.duration_ms ?? null,
    counts: item.counts as unknown as Record<string, number>,
    model: null,
  };
}

function projectStatusActivity(item: ProjectActivityItem): boolean {
  return ["status", "project", "import", "error"].includes(item.kind);
}

function systemLastActivity(items: readonly ProjectActivityItem[]): string | null {
  let latest: string | null = null;
  let latestTs = 0;
  for (const item of items) {
    if (!projectStatusActivity(item) || !item.timestamp) continue;
    const ts = parseTime(item.timestamp);
    if (ts >= latestTs) {
      latestTs = ts;
      latest = item.timestamp;
    }
  }
  return latest;
}

// ── session list ────────────────────────────────────────────────────────────

async function loadFallbackSessions(projectId: string, signal?: AbortSignal): Promise<CairnSessionList> {
  const [conversations, workers, activity] = await Promise.all([
    cairn.listConversations(projectId, signal).then(
      (response) => response.items,
      () => [] as ChatConversation[],
    ),
    cairn
      .listProjectWorkers(projectId, { limit: 100, includeTranscript: false, signal })
      .then((response) => response.items)
      .catch(() => [] as WorkerRunItem[]),
    cairn.getProjectActivity(projectId, { limit: 100, signal }).then(
      (response) => response.items,
      () => [] as ProjectActivityItem[],
    ),
  ]);

  const conversation = newestConversation(conversations);
  const main: CairnSession = {
    key: "main",
    role: "mainagent",
    title: mainTitle(conversation),
    status: conversation?.status ?? "idle",
    live: conversation?.status === "running",
    last_activity_at: conversation?.updated_at ?? null,
    tokens: {
      input: conversation?.tokens_in ?? 0,
      cache_read: 0,
      output: conversation?.tokens_out ?? 0,
      cost: 0,
    },
  };

  const reason = newestReasonRun(workers);
  const plan: CairnSession = reason
    ? {
        ...workerSession(reason),
        key: "plan",
        role: "planner",
        title: "Planner - situation assessment",
        intent_id: null,
      }
    : {
        key: "plan",
        role: "planner",
        title: "Planner - situation assessment",
        status: "idle",
        live: false,
        last_activity_at: null,
        tokens: emptyTokens(),
      };

  const lastSystem = systemLastActivity(activity);
  const system: CairnSession = {
    key: "system",
    role: "system",
    title: "System audit",
    status: "idle",
    live: lastSystem !== null && Date.now() - parseTime(lastSystem) <= 5000,
    last_activity_at: lastSystem,
    tokens: emptyTokens(),
  };

  const workersSessions = workers
    .filter((item) => item.task !== "reason")
    .sort((a, b) => workerSeverity(b) - workerSeverity(a))
    .map(workerSession);

  const sessions = [main, plan, ...workersSessions, system];
  const taskTotal = emptyTokens();
  for (const session of sessions) {
    const tokens = sessionTokens(session);
    taskTotal.input += tokens.input;
    taskTotal.cache_read += tokens.cache_read;
    taskTotal.output += tokens.output;
    taskTotal.cost += tokens.cost;
  }

  return {
    project_id: projectId,
    generated_at: new Date().toISOString(),
    project_status: "unknown",
    task_total: taskTotal,
    sessions,
    fallback: true,
  };
}

export async function fetchSessions(projectId: string, signal?: AbortSignal): Promise<CairnSessionList> {
  if (sessionsEndpointMissing(projectId)) return loadFallbackSessions(projectId, signal);
  try {
    const response = await cairnGet<CairnSessionList>(`/projects/${encodeURIComponent(projectId)}/sessions`, signal);
    return {
      ...response,
      task_total: { ...emptyTokens(), ...(response.task_total ?? {}) },
      sessions: Array.isArray(response.sessions) ? response.sessions : [],
    };
  } catch (cause) {
    if (!isMissingEndpoint(cause)) throw cause;
    markSessionsEndpointMissing(projectId);
    return loadFallbackSessions(projectId, signal);
  }
}

// ── activities ──────────────────────────────────────────────────────────────

function relativeActivitySeq(item: ProjectActivityItem, index: number): number {
  const raw = item.metadata?.activity_id;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  const fromId = /(\d+)$/.exec(item.id);
  if (fromId) return Number(fromId[1]);
  return index + 1;
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

function metaDuration(meta: Record<string, unknown>): number | null {
  const value = meta.duration_ms ?? meta.durationMs;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function activityRole(kind: string, actor: string | null): string | null {
  if (kind === "tool_result") return "tool";
  if (kind === "error") return "system";
  return actor;
}

function mapProjectActivity(item: ProjectActivityItem, index: number): SessionActivity {
  const meta = item.metadata ?? {};
  const kindMap: Record<string, string> = {
    worker_thinking: "thinking",
    tool_call: "tool_call",
    tool_result: "tool_result",
    worker_message: "message",
    worker_error: "error",
    worker_output: "status",
    status: "status",
    project: "status",
    import: "status",
    error: "error",
  };
  const kind = kindMap[item.kind] ?? "status";
  const toolName = metaString(meta, "tool_name");
  const toolCallId = metaString(meta, "tool_call_id");
  const toolInput = metaString(meta, "tool_input");
  const toolOutput = metaString(meta, "tool_output");
  const tool =
    toolName || toolCallId || toolInput || toolOutput
      ? {
          name: toolName,
          call_id: toolCallId,
          input: toolInput ?? (kind === "tool_call" ? item.description : null),
          output: toolOutput ?? (kind === "tool_result" ? item.description : null),
          duration_ms: metaDuration(meta),
          is_error: meta.is_error === true || item.status === "error",
        }
      : null;
  return {
    seq: relativeActivitySeq(item, index),
    id: item.id,
    kind,
    role: activityRole(kind, item.actor),
    status: item.status,
    content:
      kind === "tool_call" || kind === "tool_result"
        ? null
        : (item.description ?? (item.kind === "status" ? item.title : null)),
    tool,
    tokens: null,
    metadata: { ...meta, title: item.title, timestamp_source: item.timestamp_source },
    created_at: item.timestamp ?? new Date(0).toISOString(),
  };
}

function mapChatActivity(item: ChatActivity): SessionActivity {
  const kindMap: Record<string, string> = {
    thinking: "thinking",
    tool_call: "tool_call",
    message: "message",
    error: "error",
    usage: "usage",
    steering: "message",
  };
  const kind = kindMap[item.kind] ?? "status";
  const tool =
    item.tool_name || item.tool_call_id || item.tool_input || item.tool_output
      ? {
          name: item.tool_name,
          call_id: item.tool_call_id,
          input: item.tool_input,
          output: item.tool_output,
          duration_ms: null,
          is_error: item.status === "error",
        }
      : null;
  return {
    seq: item.seq,
    id: item.id,
    kind,
    role: item.role ?? null,
    status: item.status,
    content: kind === "tool_call" ? null : item.content,
    tool,
    tokens: { input: item.tokens_in ?? 0, output: item.tokens_out ?? 0, cache_read: 0 },
    metadata: { error: item.error, run_id: item.run_id, chat_kind: item.kind },
    created_at: item.created_at,
  };
}

function pageOf(key: string, items: SessionActivity[], before: number | undefined, limit: number): SessionActivityPage {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  const filtered = before === undefined ? sorted : sorted.filter((item) => item.seq < before);
  const page = filtered.slice(Math.max(0, filtered.length - limit));
  return {
    key,
    items: page,
    has_more: filtered.length > page.length,
    earliest_seq: page.length ? page[0].seq : null,
  };
}

async function fallbackActivities(
  projectId: string,
  key: string,
  before: number | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<SessionActivityPage> {
  if (key === "main") {
    const conversation = await findMainConversation(projectId, signal).catch(() => null);
    if (!conversation) return { key, items: [], has_more: false, earliest_seq: null };
    const { items } = await cairn.listChatActivities(conversation.id, 0, signal);
    return pageOf(key, items.map(mapChatActivity), before, limit);
  }

  if (key === "system") {
    const { items } = await cairn.getProjectActivity(projectId, {
      limit: 500,
      kinds: ["status", "project", "import", "error"],
      signal,
    });
    return pageOf(key, items.map(mapProjectActivity), before, limit);
  }

  let runId: string | null = null;
  if (key.startsWith("worker:")) runId = key.slice("worker:".length);
  if (key === "plan" || runId) {
    const list = await cairn.listProjectWorkers(projectId, {
      limit: 100,
      includeTranscript: false,
      signal,
    });
    const run = key === "plan" ? newestReasonRun(list.items) : list.items.find((item) => item.run_id === runId);
    if (!run) return { key, items: [], has_more: false, earliest_seq: null };
    const detail = await cairn.listProjectWorkers(projectId, {
      runId: run.run_id,
      includeTranscript: true,
      limit: 1,
      transcriptLimit: 500,
      signal,
    });
    const transcript = detail.items[0]?.transcript ?? run.transcript ?? [];
    return pageOf(key, transcript.map(mapProjectActivity), before, limit);
  }

  return { key, items: [], has_more: false, earliest_seq: null };
}

export async function fetchSessionActivities(
  projectId: string,
  key: string,
  options: { before?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<SessionActivityPage> {
  const limit = options.limit ?? PAGE_LIMIT;
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.before !== undefined) params.set("before", String(options.before));
  if (sessionsEndpointMissing(projectId)) {
    return fallbackActivities(projectId, key, options.before, limit, options.signal);
  }
  try {
    const response = await cairnGet<SessionActivityPage>(
      `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(key)}/activities?${params.toString()}`,
      options.signal,
    );
    return {
      key: response.key ?? key,
      items: Array.isArray(response.items) ? response.items : [],
      has_more: Boolean(response.has_more),
      earliest_seq: response.earliest_seq ?? response.items?.[0]?.seq ?? null,
    };
  } catch (cause) {
    if (!isMissingEndpoint(cause)) throw cause;
    markSessionsEndpointMissing(projectId);
    return fallbackActivities(projectId, key, options.before, limit, options.signal);
  }
}

/** Union two ascending activity lists by seq (dedup). */
export function mergeActivities(
  current: readonly SessionActivity[],
  incoming: readonly SessionActivity[],
): SessionActivity[] {
  if (!incoming.length) return [...current];
  const bySeq = new Map<number, SessionActivity>();
  for (const item of current) bySeq.set(item.seq, item);
  for (const item of incoming) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ── actions (existing Cairn chat flow) ──────────────────────────────────────

/**
 * Send a message to the main agent through the existing Cairn chat endpoints.
 * The sessions API exposes the newest project conversation as "main", so that
 * is the thread this console writes to (creating one only when none exists).
 */
export async function sendMainMessage(projectId: string, message: string): Promise<MainSendResult> {
  let conversation = await findMainConversation(projectId);
  if (!conversation) {
    conversation = await cairn.createConversation(projectId, message.slice(0, 80));
  }
  const result = await cairn.sendMessage(conversation.id, message);
  return { conversation: result.conversation ?? conversation, items: result.items };
}

/** Stop the in-flight main-agent turn (POST /chat/conversations/{id}/stop). */
export async function stopMainTurn(projectId: string): Promise<{ stopped: boolean; reconciled: boolean } | null> {
  const conversation = await findMainConversation(projectId);
  if (!conversation) return null;
  const result = await cairn.stopConversation(conversation.id);
  return { stopped: result.stopped, reconciled: result.reconciled };
}
