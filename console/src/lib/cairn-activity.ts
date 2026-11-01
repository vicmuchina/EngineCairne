import type { Intent, ProjectActivityItem, ProjectDetail } from "./cairn-api";

/**
 * Cairn has no activity endpoint yet (GET /projects/{id}/activity returns 404
 * and is absent from the OpenAPI schema), so the feed is derived from the
 * project detail: intent claims/conclusions, fact recording and hints.
 */

export type ActivityKind = "fact" | "intent" | "hint";
export type ActivityStatus = "claimed" | "concluded" | "unclaimed" | "recorded" | "curator";

export interface ActivityEvent {
  key: string;
  projectId: string;
  projectTitle: string;
  kind: ActivityKind;
  id: string;
  status: ActivityStatus;
  worker: string;
  description: string;
  ts: string;
  /** Set on fact events when an intent produced the fact. */
  intentId?: string;
}

const PREMISES = new Set(["origin", "goal"]);

function newestFirst(a: ActivityEvent, b: ActivityEvent): number {
  const delta = Date.parse(b.ts) - Date.parse(a.ts);
  return delta === 0 ? a.key.localeCompare(b.key) : delta;
}

export function buildProjectActivity(detail: ProjectDetail): ActivityEvent[] {
  const { project, facts, intents, hints } = detail;
  const producerByFact = new Map<string, Intent>();
  for (const intent of intents) {
    if (intent.to) producerByFact.set(intent.to, intent);
  }

  const base = { projectId: project.id, projectTitle: project.title };
  const events: ActivityEvent[] = [];

  for (const intent of intents) {
    events.push({
      ...base,
      key: `${project.id}:${intent.id}:claim`,
      kind: "intent",
      id: intent.id,
      status: intent.worker ? "claimed" : "unclaimed",
      worker: intent.worker ?? intent.creator,
      description: intent.description,
      ts: intent.created_at,
    });
    if (intent.concluded_at) {
      events.push({
        ...base,
        key: `${project.id}:${intent.id}:concluded`,
        kind: "intent",
        id: intent.id,
        status: "concluded",
        worker: intent.worker ?? "unclaimed",
        description: intent.description,
        ts: intent.concluded_at,
      });
    }
  }

  for (const fact of facts) {
    if (PREMISES.has(fact.id)) continue;
    const producer = producerByFact.get(fact.id);
    events.push({
      ...base,
      key: `${project.id}:${fact.id}:fact`,
      kind: "fact",
      id: fact.id,
      status: "recorded",
      worker: producer?.worker ?? "bootstrap",
      description: fact.description,
      ts: producer?.concluded_at ?? project.created_at,
      intentId: producer?.id,
    });
  }

  for (const hint of hints) {
    events.push({
      ...base,
      key: `${project.id}:${hint.id}:hint`,
      kind: "hint",
      id: hint.id,
      status: "curator",
      worker: hint.creator,
      description: hint.content,
      ts: hint.created_at,
    });
  }

  return events.sort(newestFirst);
}


/**
 * Last-resort fallback for a genuinely missing activity endpoint (real 404).
 * Maps the detail-derived events onto the Runtime v2 feed shape so the UI has
 * one row type. The derived feed cannot know about chat/tool/approval events.
 */
export function deriveActivityItems(detail: ProjectDetail): ProjectActivityItem[] {
  return buildProjectActivity(detail).map((event) => {
    const status =
      event.status === "claimed"
        ? "working"
        : event.status === "unclaimed"
          ? "open"
          : event.status === "concluded"
            ? "concluded"
            : event.status === "recorded"
              ? "confirmed"
              : "added";
    const kindLabel = event.kind === "fact" ? "Fact" : event.kind === "intent" ? "Intent" : "Hint";
    return {
      kind: event.kind,
      id: `${event.kind}:${event.id}`,
      project_id: event.projectId,
      timestamp: event.ts,
      timestamp_source: "derived.project_detail",
      actor: event.worker,
      status,
      title: `${kindLabel} ${event.id}`,
      description: event.description,
      metadata: event.intentId ? { intent_id: event.intentId } : {},
      source: "derived",
      cursor: null,
    };
  });
}
