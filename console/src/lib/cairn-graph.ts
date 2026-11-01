import type { Edge, TaskNode } from "@/lib/types";

import type { Intent, ProjectDetail } from "./cairn-api";

/**
 * Adapter from Cairn's project detail to the node/edge model consumed by the
 * real Artex exploration graph (src/components/exploration-graph.tsx).
 *
 * Cairn semantics:
 *  - facts "origin"/"goal" are the two premises; origin renders as Start, goal
 *    as Goal (the component special-cases fact + state="origin").
 *  - every other fact is a Finding.
 *  - an intent runs from its `from` facts and yields its `to` fact.
 *  - hints are curator notes; Cairn does not link them to intents, so they stay
 *    unattached rather than inventing edges.
 */

const PREMISES = new Set(["origin", "goal"]);

export function buildCairnGraph(detail: ProjectDetail): { nodes: TaskNode[]; edges: Edge[] } {
  const { project, facts, intents, hints } = detail;
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const producerByFact = new Map<string, Intent>();
  for (const intent of intents) {
    if (intent.to) producerByFact.set(intent.to, intent);
  }

  const nodes: TaskNode[] = [];
  const origin = factsById.get("origin");
  const goal = factsById.get("goal");

  if (origin) {
    nodes.push({
      id: "origin",
      type: "fact",
      state: "origin",
      payload: JSON.stringify({ summary: origin.description }),
      priority: 0,
      origin: "cairn",
      ts: project.created_at,
    });
  }
  if (goal) {
    nodes.push({
      id: "goal",
      type: "goal",
      state: project.status === "completed" ? "met" : "open",
      payload: JSON.stringify({ text: goal.description }),
      priority: 0,
      origin: "cairn",
      ts: project.created_at,
    });
  }

  for (const fact of facts) {
    if (PREMISES.has(fact.id)) continue;
    const producer = producerByFact.get(fact.id);
    // Artex distinguishes a Fact (objective result, e.g. bootstrap knowledge)
    // from a Finding (a vulnerability result). Cairn has a single `facts` table,
    // so classify on the strongest available evidence: an intent produced it, or
    // the text itself is a finding record (the imported Artex corpus says
    // "ARTEX FINDING #…" and carries no producer because the import lost that
    // lineage). Everything else stays a Fact.
    const isFinding =
      Boolean(producer) || /\bFINDING\b/i.test(fact.description) || /^CVE-\d/i.test(fact.description);
    nodes.push({
      id: fact.id,
      type: isFinding ? "finding" : "fact",
      state: "confirmed",
      payload: JSON.stringify({
        summary: fact.description,
        ...(producer ? { produced_by: producer.id } : {}),
      }),
      priority: 0,
      origin: producer ? "worker" : "cairn",
      ts: producer?.concluded_at ?? project.created_at,
    });
  }

  for (const intent of intents) {
    nodes.push({
      id: intent.id,
      type: "intent",
      state: intent.concluded_at ? "done" : intent.worker ? "running" : "open",
      payload: JSON.stringify({ summary: intent.description }),
      priority: 0,
      origin: "cairn",
      ts: intent.created_at,
    });
  }

  for (const hint of hints) {
    nodes.push({
      id: hint.id,
      type: "hint",
      state: "active",
      payload: hint.content,
      priority: 0,
      origin: hint.creator,
      ts: hint.created_at,
    });
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const add = (src: string, dst: string, rel: Edge["rel"]) => {
    const key = `${src}->${dst}:${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ src, dst, rel });
  };

  for (const intent of intents) {
    for (const src of intent.from) {
      if (!factsById.has(src)) continue;
      add(src, intent.id, src === "origin" ? "spawns" : "derived_from");
    }
    if (intent.to && factsById.has(intent.to)) {
      add(intent.id, intent.to, "yields");
    }
  }

  return { nodes, edges };
}
