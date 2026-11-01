/**
 * Broadcast timeline events for the Artex-shaped board.
 *
 * The board is one chronological stream: unified project activity rows plus the
 * fact graph. Facts are derived from the project detail (not from duplicated
 * activity rows) so their author can be resolved to the producing worker and
 * their timestamp to that intent's concluded_at, exactly like the Artex board.
 */

import type { Intent, ProjectActivityItem, ProjectDetail } from "./cairn-api";

export type BroadcastType = "goal" | "intent" | "fact" | "finding" | "hint" | "tool" | "entity" | "retest" | "status";

export interface BroadcastEvent {
  key: string;
  type: BroadcastType;
  /** Bare identifier, rendered with a leading `#` by the board. */
  id: string;
  status: string | null;
  author: string;
  description: string;
  timestamp: string | null;
  projectId: string;
  /** Graph node opened by clicking this row (Intent/Fact only). */
  nodeId?: string;
  title: string;
}

function activityId(item: ProjectActivityItem): string {
  const raw = item.metadata?.activity_id;
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw)) return raw;
  const event = /^event:(\d+)$/.exec(item.id);
  if (event) return event[1];
  const intent = /^intent:(.+)$/.exec(item.id);
  if (intent) return intent[1];
  const hint = /^hint:(.+)$/.exec(item.id);
  if (hint) return hint[1];
  const fact = /^fact:(.+)$/.exec(item.id);
  if (fact) return fact[1];
  return item.id;
}

function metaString(item: ProjectActivityItem, key: string): string | null {
  const value = item.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intentStatus(item: ProjectActivityItem): string {
  const concluded = metaString(item, "concluded_at");
  if (concluded) return "done";
  const status = (item.status ?? "").toLowerCase();
  if (status === "concluded" || status === "success") return "done";
  if (status === "working" || status === "running" || status === "claimed") return "working";
  if (status === "open" || status === "unclaimed") return "unclaimed";
  return status || "working";
}

function toolStatus(item: ProjectActivityItem): string {
  const status = (item.status ?? "").toLowerCase();
  if (status === "error" || status === "failed" || status === "timeout") return "error";
  if (status === "running" || status === "streaming") return "working";
  if (status === "done" || status === "success") return "done";
  return status || "done";
}

function formatToolPayload(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.command === "string") return parsed.command;
    const parts = Object.entries(parsed)
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    if (parts.length) return parts.join(" · ");
  } catch {
    // truncated JSON — leave the raw text
  }
  return raw;
}

/** Worker/status rows carry the pi protocol envelope; show the conclusion, not the JSON. */
function formatEnvelope(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(text) as {
      data?: {
        description?: unknown;
        fact?: { description?: unknown };
        complete?: { description?: unknown };
        intents?: Array<{ description?: unknown }>;
      };
      description?: unknown;
    };
    const data = parsed.data;
    const candidate =
      (typeof data?.complete?.description === "string" && data.complete.description) ||
      (typeof data?.fact?.description === "string" && data.fact.description) ||
      (typeof data?.description === "string" && data.description) ||
      (typeof data?.intents?.[0]?.description === "string" && data.intents[0].description) ||
      (typeof parsed.description === "string" && parsed.description) ||
      "";
    if (candidate.trim()) return candidate.trim();
  } catch {
    // not an envelope
  }
  return raw;
}

function formatActivityText(item: ProjectActivityItem): string {
  const raw = item.description ?? item.title;
  if (item.kind === "tool_call" || item.kind === "tool_result") return formatToolPayload(raw);
  return formatEnvelope(raw);
}

function mapActivity(item: ProjectActivityItem): BroadcastEvent | null {
  const base = {
    key: `activity:${item.kind}:${item.id}:${item.timestamp ?? ""}`,
    projectId: item.project_id,
    author: item.actor ?? "system",
    description: formatActivityText(item),
    timestamp: item.timestamp,
    title: item.title,
  };
  switch (item.kind) {
    case "intent": {
      const intentId = metaString(item, "intent_id") ?? activityId(item);
      return {
        ...base,
        type: "intent",
        id: intentId,
        status: intentStatus(item),
        nodeId: intentId,
      };
    }
    case "hint": {
      const hintId = metaString(item, "hint_id") ?? activityId(item);
      return { ...base, type: "hint", id: hintId, status: "confirmed" };
    }
    case "goal":
      return { ...base, type: "goal", id: activityId(item), status: "confirmed", nodeId: "goal" };
    case "fact":
      return {
        ...base,
        type: "fact",
        id: activityId(item),
        status: "confirmed",
        nodeId: activityId(item),
      };
    case "tool_call":
    case "tool_result":
      return { ...base, type: "tool", id: activityId(item), status: toolStatus(item) };
    case "entity":
      return {
        ...base,
        type: "entity",
        id: metaString(item, "entity_id") ?? activityId(item),
        status: item.status ?? "discovered",
      };
    case "finding":
      return {
        ...base,
        type: "finding",
        id: metaString(item, "finding_id") ?? activityId(item),
        status: item.status ?? "confirmed",
      };
    case "retest":
      return {
        ...base,
        type: "retest",
        id: metaString(item, "retest_id") ?? activityId(item),
        status: item.status ?? "queued",
      };
    case "status":
    case "project":
    case "import":
    case "error":
    case "worker":
    case "worker_run":
    case "worker_output":
    case "worker_message":
    case "approval":
    case "steering":
    case "chat":
    case "compaction":
      return { ...base, type: "status", id: activityId(item), status: item.status ?? null };
    default:
      return { ...base, type: "status", id: activityId(item), status: item.status ?? null };
  }
}

function deriveFactEvents(detail: ProjectDetail | null): BroadcastEvent[] {
  if (!detail) return [];
  const producerByFact = new Map<string, Intent>();
  for (const intent of detail.intents) {
    if (intent.to) producerByFact.set(intent.to, intent);
  }
  return detail.facts.map((fact) => {
    const producer = producerByFact.get(fact.id);
    const isGoal = fact.id === "goal";
    const isOrigin = fact.id === "origin";
    const type: BroadcastType = isGoal ? "goal" : !isOrigin && !producer ? "finding" : "fact";
    const author = producer ? (producer.worker ?? producer.creator) : "import";
    return {
      key: `fact:${fact.id}`,
      type,
      id: fact.id,
      status: "confirmed",
      author,
      description: fact.description,
      timestamp: producer?.concluded_at ?? detail.project.created_at,
      projectId: detail.project.id,
      nodeId: fact.id,
      title: `${type === "goal" ? "Goal" : type === "finding" ? "Finding" : "Fact"} ${fact.id}`,
    };
  });
}

/**
 * `includeDerivedFacts` keeps the project detail facts and drops the activity
 * feed's duplicate fact/goal projections. When the detail is unavailable the
 * activity rows are used as-is so the board still shows something real.
 */
export function buildBroadcastEvents(
  items: readonly ProjectActivityItem[],
  detail: ProjectDetail | null,
): BroadcastEvent[] {
  const derived = deriveFactEvents(detail);
  const seen = new Set<string>();
  const events: BroadcastEvent[] = [];
  for (const event of derived) {
    if (seen.has(event.key)) continue;
    seen.add(event.key);
    events.push(event);
  }
  for (const item of items) {
    if (detail && (item.kind === "fact" || item.kind === "goal")) continue;
    const event = mapActivity(item);
    if (!event) continue;
    const key = `${event.key}:${event.type}:${event.id}:${event.status ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  return events;
}

export function timestampOf(event: BroadcastEvent): number | null {
  if (!event.timestamp) return null;
  const value = Date.parse(event.timestamp);
  return Number.isFinite(value) ? value : null;
}

/** Local-time bucket key (`2026-10-31`). */
export function dateKey(timestamp: string | null): string {
  if (!timestamp) return "unknown";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function dateLabel(timestamp: string | null, now = Date.now()): string {
  if (!timestamp) return "Unknown date";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}
