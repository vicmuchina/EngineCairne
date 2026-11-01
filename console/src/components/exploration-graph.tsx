"use client";
"use no memo";

import * as React from "react";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge as RFEdge,
  type Node as RFNode,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Bug, Compass, Crosshair, Flag, FlaskConical, Layers, Lightbulb, type LucideIcon, Target, X } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type Tone, toneClasses } from "@/lib/status";
import type { Edge, ExploreKind, TaskNode } from "@/lib/types";
import { cn } from "@/lib/utils";

export const relLabel: Record<string, string> = {
  spawns: "spawned",
  derived_from: "intent chain",
  yields: "produced",
  proves: "proves",
};

export const relColor: Record<string, string> = {
  spawns: "#10b981",
  derived_from: "#6366f1",
  yields: "#f59e0b",
  proves: "#ef4444",
};

type TypeMeta = {
  label: string;
  icon: LucideIcon;
  iconBg: string;
  chip: string;
  hex: string;
};

const typeMeta: Record<ExploreKind, TypeMeta> = {
  task: {
    label: "Root task",
    icon: Flag,
    iconBg: "bg-slate-500",
    chip: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    hex: "#64748b",
  },
  begin: {
    label: "Start",
    icon: Flag,
    iconBg: "bg-slate-500",
    chip: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    hex: "#64748b",
  },
  goal: {
    label: "Goal",
    icon: Target,
    iconBg: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    hex: "#10b981",
  },
  hint: {
    label: "Hint",
    icon: Lightbulb,
    iconBg: "bg-violet-500",
    chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    hex: "#8b5cf6",
  },
  intent: {
    label: "Intent",
    icon: Compass,
    iconBg: "bg-blue-500",
    chip: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    hex: "#3b82f6",
  },
  fact: {
    label: "Fact",
    icon: FlaskConical,
    iconBg: "bg-amber-500",
    chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    hex: "#f59e0b",
  },
  finding: {
    label: "Finding",
    icon: Bug,
    iconBg: "bg-rose-500",
    chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    hex: "#f43f5e",
  },
  digest: {
    label: "Compaction",
    icon: Layers,
    iconBg: "bg-teal-500",
    chip: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
    hex: "#14b8a6",
  },
  group: {
    label: "Group",
    icon: Layers,
    iconBg: "bg-teal-600",
    chip: "bg-teal-600/15 text-teal-700 dark:text-teal-400",
    hex: "#0d9488",
  },
};

// The task root is an origin fact (kind='fact', state='origin'); render it as "Start".
function viewKind(n: TaskNode): ExploreKind {
  return n.type === "fact" && n.state === "origin" ? "begin" : n.type;
}

function prioTone(p: number): Tone {
  return p >= 8 ? "red" : p >= 5 ? "amber" : "slate";
}

const summaryFields: Record<ExploreKind, string[]> = {
  task: ["summary", "description"],
  begin: ["summary", "description"],
  goal: ["text"],
  hint: [],
  intent: ["summary"],
  fact: ["summary"],
  finding: ["name", "summary"],
  digest: ["body"],
  group: ["body"],
};

function nodeSummary(n: TaskNode): string {
  const raw = n.payload ?? "";
  const fields = summaryFields[viewKind(n)] ?? [];
  if (fields.length && raw.trim()) {
    try {
      const obj: unknown = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        for (const f of fields) {
          const v = (obj as Record<string, unknown>)[f];
          if (typeof v === "string" && v.trim()) return v;
        }
      }
    } catch {
      /* Not JSON: show it verbatim */
    }
  }
  return raw;
}

// digestMemberIds reads the fact/intent ids a digest folds from its payload
// (member_ids.{facts,intents}); ids are numbers in JSON, node ids are strings.
function digestMemberIds(n: TaskNode): string[] {
  if ((n.type !== "digest" && n.type !== "group") || !n.payload) return [];
  try {
    const p = JSON.parse(n.payload) as {
      member_ids?: { facts?: Array<string | number>; intents?: Array<string | number> };
    };
    return [...(p.member_ids?.facts ?? []), ...(p.member_ids?.intents ?? [])].map(String);
  } catch {
    return [];
  }
}

// collapseDigestGraph contracts each active digest's covered members into the
// digest super-node: the members are dropped from the rendered set and every
// edge touching a member is rewired onto its digest (member→member internal
// edges collapse to a self-loop and are dropped; the resulting edges are
// deduped by src+rel+dst). covers edges are structural and never drawn.
// Superseded digests (no covers edges) are dropped entirely. A graph with no
// active digest passes through unchanged. The full node list is kept by the
// caller so the detail drawer can still resolve a folded member by id.
function collapseDigestGraph(nodes: TaskNode[], edges: Edge[]): { viewNodes: TaskNode[]; viewEdges: Edge[] } {
  const activeDigests = new Set(nodes.filter((n) => n.type === "digest" && n.state === "active").map((n) => n.id));
  const memberToDigest = new Map<string, string>();
  for (const e of edges) {
    if (e.rel === "covers" && activeDigests.has(e.src)) memberToDigest.set(e.dst, e.src);
  }
  const viewNodes = nodes.filter((n) => (n.type === "digest" ? n.state === "active" : !memberToDigest.has(n.id)));
  const remap = (id: string) => memberToDigest.get(id) ?? id;
  const seen = new Set<string>();
  const rewired: Edge[] = [];
  // src+dst of every rewired yields edge, so the inverse derived_from can be dropped.
  const produced = new Set<string>();
  for (const e of edges) {
    if (e.rel === "covers") continue;
    const src = remap(e.src);
    const dst = remap(e.dst);
    if (src === dst) continue;
    const key = `${src}\u0000${e.rel}\u0000${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.rel === "yields") produced.add(`${src} ${dst}`);
    rewired.push(src === e.src && dst === e.dst ? e : { ...e, src, dst });
  }
  // yields(A→B) and derived_from(B→A) are inverse relations: a finding is
  // yielded by one intent but derived_from other intents, so the raw graph has
  // no 2-cycle. Folding those distinct intents into one digest collapses both
  // onto the digest↔member pair, leaving a redundant reverse edge the layered
  // layout draws as an overlapping back-edge. Drop each derived_from whose
  // reverse yields exists, keeping the production direction (→member).
  const viewEdges = rewired.filter((e) => !(e.rel === "derived_from" && produced.has(`${e.dst} ${e.src}`)));
  return { viewNodes, viewEdges };
}

const COMPACT_MIN_NODES = 30;
const COMPACT_TARGET_GROUPS = 5;
const COMPACT_UNITS_PER_GROUP = 13;
const COMPACT_COL_W = 320;
const COMPACT_ROW_H = 140;
const COMPACT_TOP = 80;
const COMPACT_NODE_W = 240;

type CompactGraph = { viewNodes: TaskNode[]; viewEdges: Edge[]; grouped: boolean };

function nodeTime(n: TaskNode): number {
  const t = Date.parse(n.ts);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Collapse completed history into a handful of inspectable group cards while
 * keeping the live frontier (open/running intents and their adjacent facts)
 * expanded. A 126-node project otherwise fits at a scale where every card is
 * a hairline. The caller can still request the full graph explicitly.
 */
function compactCompletedGraph(nodes: TaskNode[], edges: Edge[]): CompactGraph {
  if (nodes.length <= COMPACT_MIN_NODES) return { viewNodes: nodes, viewEdges: edges, grouped: false };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const openIntents = new Set(
    nodes.filter((n) => n.type === "intent" && n.state !== "done").map((n) => n.id),
  );
  const visible = new Set<string>();

  for (const n of nodes) {
    if (n.type === "fact" && n.state === "origin") visible.add(n.id);
    else if (n.type === "intent" && n.state !== "done") visible.add(n.id);
    else if (n.type !== "intent" && n.type !== "fact") visible.add(n.id);
  }

  // Facts touching an open/running intent stay on the canvas so the live edge
  // of the exploration is never hidden inside a completed-history group.
  for (const e of edges) {
    if (e.rel === "covers") continue;
    // Keep the target of a live intent visible. Its source facts are completed
    // history and belong in a group; the group drawer still lists them.
    if (openIntents.has(e.src) && e.rel === "yields") visible.add(e.dst);
  }

  const producedBy = new Map<string, string[]>();
  for (const e of edges) {
    if (e.rel !== "yields") continue;
    const a = producedBy.get(e.src);
    if (a) a.push(e.dst);
    else producedBy.set(e.src, [e.dst]);
  }

  const used = new Set(visible);
  const units: TaskNode[][] = [];
  for (const n of nodes) {
    if (n.type !== "intent" || n.state !== "done" || used.has(n.id)) continue;
    const unit: TaskNode[] = [n];
    used.add(n.id);
    for (const factId of producedBy.get(n.id) ?? []) {
      const fact = byId.get(factId);
      if (fact?.type === "fact" && !used.has(factId)) {
        unit.push(fact);
        used.add(factId);
      }
    }
    units.push(unit);
  }
  for (const n of nodes) {
    if (n.type === "fact" && !used.has(n.id)) {
      units.push([n]);
      used.add(n.id);
    }
  }

  if (units.length < 4) return { viewNodes: nodes, viewEdges: edges, grouped: false };

  units.sort((a, b) => nodeTime(a[0]) - nodeTime(b[0]));
  const groupCount = Math.min(
    COMPACT_TARGET_GROUPS,
    Math.max(3, Math.ceil(units.length / COMPACT_UNITS_PER_GROUP)),
  );
  const chunkSize = Math.ceil(units.length / groupCount);
  const groups: Array<{ id: string; members: TaskNode[] }> = [];
  for (let i = 0; i < units.length; i += chunkSize) {
    const members = units.slice(i, i + chunkSize).flat();
    if (members.length) groups.push({ id: `compact-group-${groups.length + 1}`, members });
  }

  const memberToGroup = new Map<string, string>();
  const groupNodes: TaskNode[] = groups.map((group) => {
    const intents = group.members.filter((n) => n.type === "intent");
    const facts = group.members.filter((n) => n.type === "fact");
    for (const member of group.members) memberToGroup.set(member.id, group.id);
    const last = [...group.members].sort((a, b) => nodeTime(b) - nodeTime(a))[0];
    return {
      id: group.id,
      type: "group",
      state: "active",
      payload: JSON.stringify({
        body: `${intents.length} completed intent${intents.length === 1 ? "" : "s"} · ${facts.length} finding${
          facts.length === 1 ? "" : "s"
        }`,
        member_ids: {
          facts: facts.map((n) => n.id),
          intents: intents.map((n) => n.id),
        },
      }),
      priority: 0,
      origin: "cairn",
      ts: last?.ts ?? "",
    };
  });

  const seen = new Set<string>();
  const viewEdges: Edge[] = [];
  for (const e of edges) {
    if (e.rel === "covers") continue;
    const src = memberToGroup.get(e.src) ?? e.src;
    const dst = memberToGroup.get(e.dst) ?? e.dst;
    if (src === dst) continue;
    const key = `${src}\u0000${e.rel}\u0000${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    viewEdges.push(src === e.src && dst === e.dst ? e : { ...e, src, dst });
  }

  return {
    viewNodes: [...nodes.filter((n) => visible.has(n.id) || n.type === "digest"), ...groupNodes],
    viewEdges,
    grouped: true,
  };
}

function computeCompactLayout(nodes: TaskNode[], width: number): Map<string, { x: number; y: number }> {
  const naturalColumns = Math.max(2, Math.min(4, Math.round((width || 960) / COMPACT_COL_W)));
  // With a small digest (current project: 9 cards), 3 columns reads better
  // than an orphaned 4+4+1 last row at 1440. Larger digests can use four.
  const columns = nodes.length <= 12 ? Math.min(naturalColumns, 3) : naturalColumns;
  const rank = (n: TaskNode) => {
    if (n.type === "fact" && n.state === "origin") return 0;
    if (n.type === "goal") return 1;
    if (n.type === "group") return 2;
    if (n.type === "intent") return 3;
    if (n.type === "fact") return 4;
    return 5;
  };
  const ordered = [...nodes].sort((a, b) => rank(a) - rank(b) || nodeTime(a) - nodeTime(b));
  const pos = new Map<string, { x: number; y: number }>();
  ordered.forEach((n, i) => {
    pos.set(n.id, {
      x: (i % columns) * COMPACT_COL_W,
      y: COMPACT_TOP + Math.floor(i / columns) * COMPACT_ROW_H,
    });
  });
  return pos;
}

const COL_W = 360;
const ROW_H = 140;

type ExploreNodeData = { node: TaskNode };
type ExploreRFNode = RFNode<ExploreNodeData, "explore">;

function pushMap(m: Map<string, string[]>, k: string, v: string) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

// computeLayout auto-layers nodes by longest path along edges (cycle-safe DFS
// break + barycenter ordering), so origin → … → finding reads left-to-right.
function computeLayout(nodes: TaskNode[], edges: Edge[]): Map<string, { x: number; y: number }> {
  const order = nodes.map((n) => n.id);
  const idset = new Set(order);
  const valid = edges.filter((e) => idset.has(e.src) && idset.has(e.dst));
  const key = (s: string, d: string) => `${s}->${d}`;

  const out = new Map<string, string[]>();
  for (const e of valid) pushMap(out, e.src, e.dst);

  const seen = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  for (const root of order) {
    if ((seen.get(root) ?? 0) !== 0) continue;
    const stack: Array<{ u: string; i: number }> = [{ u: root, i: 0 }];
    seen.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nbrs = out.get(top.u) ?? [];
      if (top.i >= nbrs.length) {
        seen.set(top.u, 2);
        stack.pop();
        continue;
      }
      const v = nbrs[top.i++];
      const s = seen.get(v) ?? 0;
      if (s === 1) back.add(key(top.u, v));
      else if (s === 0) {
        seen.set(v, 1);
        stack.push({ u: v, i: 0 });
      }
    }
  }

  const dagSucc = new Map<string, string[]>();
  const indeg = new Map<string, number>(order.map((id) => [id, 0]));
  for (const e of valid) {
    if (back.has(key(e.src, e.dst))) continue;
    pushMap(dagSucc, e.src, e.dst);
    indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
  }
  const layer = new Map<string, number>(order.map((id) => [id, 0]));
  const queue = order.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of dagSucc.get(u) ?? []) {
      layer.set(v, Math.max(layer.get(v) ?? 0, (layer.get(u) ?? 0) + 1));
      const d = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, d);
      if (d === 0) queue.push(v);
    }
  }

  const maxLayer = Math.max(0, ...layer.values());
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of order) columns[layer.get(id) ?? 0].push(id);

  const colIndexOf = new Map<string, number>();
  columns.forEach((ids, c) => {
    ids.forEach((id) => {
      colIndexOf.set(id, c);
    });
  });
  const neighbors = new Map<string, string[]>();
  for (const e of valid) {
    const cs = colIndexOf.get(e.src);
    const cd = colIndexOf.get(e.dst);
    if (cs === undefined || cd === undefined || Math.abs(cs - cd) !== 1) continue;
    pushMap(neighbors, e.src, e.dst);
    pushMap(neighbors, e.dst, e.src);
  }
  const sweep = (dir: 1 | -1) => {
    const start = dir === 1 ? 1 : columns.length - 2;
    const end = dir === 1 ? columns.length : -1;
    for (let c = start; c !== end; c += dir) {
      const ref = c - dir;
      const refIndex = new Map(columns[ref].map((id, i) => [id, i]));
      const scored = columns[c].map((id, i) => {
        const ns = (neighbors.get(id) ?? [])
          .map((nid) => refIndex.get(nid))
          .filter((v): v is number => v !== undefined);
        const bary = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i;
        return { id, bary, i };
      });
      scored.sort((a, b) => a.bary - b.bary || a.i - b.i);
      columns[c] = scored.map((s) => s.id);
    }
  };
  for (let iter = 0; iter < 4; iter++) {
    sweep(1);
    sweep(-1);
  }

  // A wide project can put most of its nodes in one topological layer (e.g. an
  // imported corpus whose findings have no producer). Stacking 80 cards in a single
  // column makes fitView zoom out to ~7%, where every card is a hairline. Wrap each
  // layer into readable bands instead: the layer keeps its left-to-right order, and
  // extra bands sit to its right with their own vertical centering.
  const MAX_COLUMN = 14;
  const bandCounts = columns.map((ids) => Math.max(1, Math.ceil(ids.length / MAX_COLUMN)));
  const layerX: number[] = [];
  let nextX = 0;
  bandCounts.forEach((bands, index) => {
    layerX[index] = nextX;
    nextX += bands;
  });

  const maxCount = Math.min(MAX_COLUMN, Math.max(1, ...columns.map((c) => c.length)));
  const midline = ((maxCount - 1) * ROW_H) / 2;
  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((ids, c) => {
    const bands = bandCounts[c];
    for (let band = 0; band < bands; band++) {
      const slice = ids.slice(band * MAX_COLUMN, (band + 1) * MAX_COLUMN);
      const startY = midline - ((slice.length - 1) * ROW_H) / 2;
      slice.forEach((id, i) => {
        pos.set(id, { x: (layerX[c] + band) * COL_W, y: startY + i * ROW_H });
      });
    }
  });
  return pos;
}

// Dify-style node card.
function ExploreNode({ data, selected }: NodeProps<ExploreRFNode>) {
  const n = data.node;
  const kind = viewKind(n);
  const meta = typeMeta[kind] ?? typeMeta.intent;
  const Icon = meta.icon;
  const showState = n.type === "goal" || n.type === "intent";
  const showPriority = (n.type === "goal" || n.type === "intent") && n.priority > 0;
  const isLive = !n.inherited && n.type === "intent" && n.state === "running";

  return (
    <div
      className={cn(
        "w-[240px] cursor-pointer rounded-2xl border-2 transition-colors",
        selected ? "border-blue-500" : isLive ? "border-blue-400/70" : "border-transparent",
      )}
    >
      <div className="group relative overflow-hidden rounded-[14px] border border-black/[0.06] bg-white shadow-sm transition-shadow hover:shadow-lg dark:border-white/10 dark:bg-neutral-900">
        <Handle
          type="target"
          position={Position.Left}
          className="!size-2 !border-2 !border-neutral-300 !bg-white opacity-0 transition-opacity group-hover:opacity-100 dark:!border-neutral-600 dark:!bg-neutral-800"
        />
        <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-lg shadow-sm", meta.iconBg)}>
            <Icon className="size-3.5 text-white" />
          </span>
          <span className="grow truncate text-[13px] font-semibold text-neutral-700 dark:text-neutral-100">
            {meta.label}
          </span>
          {isLive && (
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-70" />
              <span className="relative inline-flex size-2 rounded-full bg-blue-500" />
            </span>
          )}
          {showPriority && (
            <span
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                toneClasses[prioTone(n.priority)],
              )}
            >
              P{n.priority}
            </span>
          )}
        </div>
        <div className="line-clamp-3 overflow-hidden px-3 pb-2 text-[13px] leading-snug text-neutral-500 dark:text-neutral-400">
          {nodeSummary(n) || meta.label}
        </div>
        <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
          {n.inherited && n.source_task_id ? (
            <Badge
              variant="outline"
              className="max-w-32 truncate"
              title={`Inherited from task #${n.source_task_id}, read-only`}
            >
              From #{n.source_task_id}
            </Badge>
          ) : showState ? (
            <StatusBadge
              domain={n.type === "goal" ? "goal" : "intent"}
              value={n.state}
              dot
              className="px-1.5 py-0 text-[10px]"
            />
          ) : (
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500">{meta.label}</span>
          )}
          <span
            className="max-w-[45%] shrink-0 truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500"
            title={`#${n.id}`}
          >
            #{n.id}
          </span>
        </div>
        <Handle
          type="source"
          position={Position.Right}
          className="!size-2 !border-2 !border-neutral-300 !bg-white opacity-0 transition-opacity group-hover:opacity-100 dark:!border-neutral-600 dark:!bg-neutral-800"
        />
      </div>
    </div>
  );
}

const nodeTypes = { explore: ExploreNode };

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground w-14 shrink-0">{label}</span>
      <span className="text-foreground min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function NodeDetailPanel({
  node,
  nodesById,
  onSelect,
  onClose,
  onFocus,
}: {
  node: TaskNode | null;
  nodesById: Map<string, TaskNode>;
  onSelect: (n: TaskNode) => void;
  onClose: () => void;
  onFocus: (n: TaskNode) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const meta = node ? (typeMeta[viewKind(node)] ?? typeMeta.intent) : null;
  const Icon = meta?.icon;
  if (!node || !meta || !Icon) return null;
  const raw = JSON.stringify(node, null, 2);
  const memberIds = digestMemberIds(node);
  const members = memberIds.map((id) => nodesById.get(id)).filter((m): m is TaskNode => !!m);

  const copy = () => {
    void navigator.clipboard?.writeText(raw).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <aside className="bg-card flex h-full w-[360px] max-w-[50%] shrink-0 flex-col gap-0 overflow-hidden border-l">
      <div className="flex items-center gap-2.5 border-b p-4 pr-12">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg shadow-sm", meta.iconBg)}>
          <Icon className="size-4 text-white" />
        </span>
        <div className="min-w-0">
          <h2 className="font-heading text-foreground text-base leading-tight font-medium">{meta.label}</h2>
          <span className="text-muted-foreground font-mono text-xs">{node.id}</span>
        </div>
        {node.inherited && node.source_task_id && (
          <Badge variant="outline" className="ml-auto shrink-0">
            From task #{node.source_task_id} - read-only
          </Badge>
        )}
        <button
          type="button"
          onClick={() => onFocus(node)}
          className="text-muted-foreground hover:text-foreground hover:bg-accent ml-auto flex size-8 shrink-0 items-center justify-center rounded-md transition-colors"
          title="Center this node at 1:1"
          aria-label="Center this node at 1:1"
        >
          <Crosshair className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground hover:bg-accent absolute top-3 right-3 flex size-8 items-center justify-center rounded-md transition-colors"
          aria-label="Close details"
        >
          <X className="size-4" />
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1 overflow-x-hidden">
        <div className="flex w-full min-w-0 max-w-full flex-col gap-4 p-4">
          {nodeSummary(node) && (
            <section>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium">Summary</h4>
              <p className="text-foreground text-sm leading-relaxed break-words whitespace-pre-wrap">
                {nodeSummary(node)}
              </p>
            </section>
          )}

          <section>
            <h4 className="text-muted-foreground mb-1 text-xs font-medium">Attributes</h4>
            <DetailRow label="Type">{meta.label}</DetailRow>
            <DetailRow label="State">
              {node.type === "goal" || node.type === "intent" ? (
                <StatusBadge
                  domain={node.type === "goal" ? "goal" : "intent"}
                  value={node.state}
                  dot
                  className="px-1.5 py-0 text-[10px]"
                />
              ) : (
                <span className="font-mono text-xs">{node.state}</span>
              )}
            </DetailRow>
            <DetailRow label="Priority">
              <span className="tabular-nums">{node.priority}</span>
            </DetailRow>
            <DetailRow label="Origin">
              <span className="font-mono text-xs">{node.origin}</span>
            </DetailRow>
            {node.inherited && node.source_task_id && (
              <DetailRow label="Source task">
                <span className="font-mono text-xs">#{node.source_task_id} (inherited, read-only)</span>
              </DetailRow>
            )}
            <DetailRow label="Time">{new Date(node.ts).toLocaleString()}</DetailRow>
          </section>

          {(node.type === "digest" || node.type === "group") && (
            <>
              {node.type === "digest" && nodeSummary(node) && (
                <section className="border-t pt-3">
                  <h4 className="text-muted-foreground mb-1.5 text-xs font-medium">The compacted conclusion</h4>
                  <p className="text-foreground text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {nodeSummary(node)}
                  </p>
                </section>
              )}
              <section className="min-w-0 border-t pt-3">
                <h4 className="text-muted-foreground mb-1.5 text-xs font-medium">
                  {node.type === "group" ? "Grouped nodes" : "Compacted nodes"} ({memberIds.length})
                </h4>
                <div className="flex w-full min-w-0 flex-col gap-1.5 overflow-hidden">
                  {members.map((m) => {
                    const mMeta = typeMeta[viewKind(m)] ?? typeMeta.intent;
                    const MIcon = mMeta.icon;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => onSelect(m)}
                        className="hover:bg-accent flex w-full min-w-0 max-w-full items-start gap-2 overflow-hidden rounded-md border p-2 text-left transition-colors"
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded",
                            mMeta.iconBg,
                          )}
                        >
                          <MIcon className="size-3 text-white" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground line-clamp-2 block w-full min-w-0 text-xs leading-snug [overflow-wrap:anywhere] whitespace-normal">
                            {nodeSummary(m) || mMeta.label}
                          </span>
                          <span className="text-muted-foreground block font-mono text-[10px]">
                            {mMeta.label} · #{m.id}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {members.length < memberIds.length && (
                    <span className="text-muted-foreground text-[10px]">
                      {memberIds.length - members.length} more member nodes were not loaded with the current graph
                    </span>
                  )}
                </div>
              </section>
            </>
          )}

          <section className="border-t pt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <h4 className="text-muted-foreground text-xs font-medium">Raw data</h4>
              <button
                type="button"
                onClick={copy}
                className="text-muted-foreground hover:text-foreground text-xs transition-colors"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="bg-muted/50 text-foreground max-w-full overflow-hidden rounded-md border p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
              {raw}
            </pre>
          </section>
        </div>
      </ScrollArea>
    </aside>
  );
}

// ExplorationGraphInner renders the given nodes/edges as a React Flow canvas.
// Positions are auto-laid-out and preserved across prop updates (so a polling
// caller's graph doesn't jump); click a node to open its detail drawer.
function ExplorationGraphInner({
  nodes,
  edges,
  emptyHint = "No exploration data yet",
  fitViewOptions,
  legendKinds,
  legendRels,
  focusNodeId,
  fitView = true,
  compact = false,
}: {
  nodes: TaskNode[];
  edges: Edge[];
  emptyHint?: string;
  fitViewOptions?: React.ComponentProps<typeof ReactFlow>["fitViewOptions"];
  legendKinds?: ExploreKind[];
  legendRels?: Array<keyof typeof relLabel>;
  focusNodeId?: string;
  fitView?: boolean;
  compact?: boolean;
}) {
  const graphRef = React.useRef<HTMLDivElement>(null);
  const [graphWidth, setGraphWidth] = React.useState(0);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<ExploreRFNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
  const [selected, setSelected] = React.useState<TaskNode | null>(null);
  const selectedId = selected?.id ?? null;
  // Full node index (incl. folded members) so the digest/group drawer can
  // resolve members even though they are not rendered on the canvas.
  const nodesById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized({ includeHiddenNodes: true });
  const focusedRef = React.useRef<string | null>(null);
  const modeRef = React.useRef<boolean | null>(null);
  const fitOptions = React.useMemo(() => {
    const base = fitViewOptions ?? { padding: 0.2, minZoom: 0.01, maxZoom: 1 };
    return compact ? { ...base, padding: 0.08 } : base;
  }, [fitViewOptions, compact]);

  React.useEffect(() => {
    const element = graphRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setGraphWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Collapsed view: folded members removed, their edges rewired onto the digest.
  const collapsed = React.useMemo(() => collapseDigestGraph(nodes, edges), [nodes, edges]);
  // Compact view: completed history becomes a small set of inspectable group
  // cards; the live frontier remains expanded. Full graph is one click away.
  const compacted = React.useMemo(
    () =>
      compact
        ? compactCompletedGraph(collapsed.viewNodes, collapsed.viewEdges)
        : { ...collapsed, grouped: false },
    [compact, collapsed],
  );
  const viewNodes = compacted.viewNodes;
  const viewEdges = compacted.viewEdges;
  const isEmpty = viewNodes.length === 0;

  const layout = React.useMemo(
    () => (compact ? computeCompactLayout(viewNodes, graphWidth) : computeLayout(viewNodes, viewEdges)),
    [compact, viewNodes, viewEdges, graphWidth],
  );

  const centerOnNode = React.useCallback(
    (node: TaskNode, duration = 450) => {
      const target = flow.getNode(node.id);
      if (!target) return;
      // The inspector is a layout sibling, so the graph viewport already
      // excludes it. Centering on the node is sufficient; no hidden overlay
      // needs to be compensated for.
      flow.setCenter(target.position.x + COMPACT_NODE_W / 2, target.position.y + 50, {
        zoom: 1,
        duration,
      });
    },
    [flow],
  );

  React.useEffect(() => {
    setSelected((current) => (current ? (nodesById.get(current.id) ?? current) : current));
  }, [nodesById]);

  React.useEffect(() => {
    const liveTargets = new Set(
      viewNodes.filter((n) => !n.inherited && n.type === "intent" && n.state === "running").map((n) => n.id),
    );
    const groupIds = new Set(viewNodes.filter((n) => n.type === "group").map((n) => n.id));
    setRfNodes((previous) => {
      const modeChanged = modeRef.current !== compact;
      modeRef.current = compact;
      const previousPositions = new Map(previous.map((node) => [node.id, node.position]));
      return viewNodes.map((node) => ({
        id: node.id,
        type: "explore" as const,
        position:
          compact || modeChanged
            ? (layout.get(node.id) ?? { x: 0, y: 0 })
            : (previousPositions.get(node.id) ?? layout.get(node.id) ?? { x: 0, y: 0 }),
        data: { node },
        selected: node.id === selectedId,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      }));
    });
    setRfEdges(
      viewEdges.map((edge, index) => {
        const color = relColor[edge.rel] ?? "#94a3b8";
        const animated = liveTargets.has(edge.dst);
        const groupToGroup = groupIds.has(edge.src) && groupIds.has(edge.dst);
        return {
          id: `e${index}-${edge.src}-${edge.dst}`,
          source: edge.src,
          target: edge.dst,
          label: compact ? undefined : (relLabel[edge.rel] ?? edge.rel),
          type: "default",
          animated,
          labelShowBg: false,
          labelStyle: { fontSize: 10, fontWeight: 600, fill: color },
          style: {
            stroke: color,
            strokeWidth: compact ? 1.5 : 2,
            strokeOpacity: compact ? (groupToGroup ? 0.12 : animated ? 0.55 : 0.3) : animated ? 0.9 : 0.55,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        } satisfies RFEdge;
      }),
    );
  }, [viewNodes, viewEdges, layout, compact, selectedId, setRfNodes, setRfEdges]);

  React.useEffect(() => {
    setSelected(null);
  }, [compact]);

  // Fit after the node DOM has measured. A single deferred fit still races
  // React Flow when 126 nodes mount at once (fitView can run before dimensions
  // exist and then never retry). Re-fit at a few short delays so the final
  // bounds are always used; the timers are cleared on the next layout change.
  const fittedKey = React.useRef<string>("");
  React.useEffect(() => {
    if (!fitView || focusNodeId || isEmpty || !nodesInitialized || rfNodes.length === 0) return;
    // Fit once per layout mode/width. Re-fitting whenever a worker appends a node
    // (or the user selects one) would yank the viewport back from a manual zoom.
    const key = `${compact ? "compact" : "full"}:${graphWidth}`;
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    const fit = () => flow.fitView({ ...fitOptions, duration: 0 });
    const timers = [0, 120, 400].map((delay) => window.setTimeout(fit, delay));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [
    fitView,
    focusNodeId,
    isEmpty,
    nodesInitialized,
    rfNodes.length,
    flow,
    fitOptions,
    compact,
    graphWidth,
  ]);

  React.useEffect(() => {
    if (!fitView || focusNodeId) return;
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => flow.fitView({ ...fitOptions, duration: 0 }), 160);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(timer);
    };
  }, [fitView, focusNodeId, flow, fitOptions]);

  // Focus a node selected from Findings (or the inspector's center button):
  // open the non-modal panel and center the node at 1:1. The selected node is
  // explicitly marked in the RF node state so its blue border is visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry once React Flow applies the computed positions
  React.useEffect(() => {
    if (!focusNodeId) {
      focusedRef.current = null;
      return;
    }
    if (focusedRef.current === focusNodeId) return;
    const target = flow.getNode(focusNodeId);
    const node = nodesById.get(focusNodeId);
    if (!target || !node) return;
    focusedRef.current = focusNodeId;
    setSelected(node);
    // A Findings click can mount this graph in the same commit as the focus
    // request; the first setCenter may run before the viewport has dimensions.
    // Retry a few times so the 1:1 focus is never left at the canvas edge.
    const timers = [0, 150, 500, 1000].map((delay) =>
      window.setTimeout(() => centerOnNode(node, 0), delay),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [focusNodeId, flow, nodesById, centerOnNode]);

  return (
    <div className="flex h-full w-full min-w-0">
      <div ref={graphRef} className="relative h-full min-w-0 flex-1">
      <ReactFlow
        key={selectedId ? "with-inspector" : "without-inspector"}
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => setSelected(node.data.node)}
        onPaneClick={() => setSelected(null)}
        nodeTypes={nodeTypes}
        fitView={fitView}
        fitViewOptions={fitOptions}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={false}
        minZoom={0.01}
        className="!bg-[#f0f2f7] dark:!bg-neutral-950"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          className="text-neutral-400/50 dark:text-neutral-700/60"
        />
        <Controls
          showInteractive={false}
          fitViewOptions={fitOptions}
          className="!rounded-lg !border !shadow-sm [&>button]:!border-border [&>button]:!bg-card [&>button:hover]:!bg-accent [&_svg]:!fill-foreground"
        />
        <MiniMap
          pannable
          zoomable
          className="!bg-card !rounded-lg !border !shadow-sm"
          maskColor="rgb(148 163 184 / 0.18)"
          nodeColor={(node) => {
            const data = node.data as ExploreNodeData | undefined;
            const k = data?.node ? viewKind(data.node) : "intent";
            return typeMeta[k]?.hex ?? "#94a3b8";
          }}
          nodeStrokeWidth={0}
          nodeBorderRadius={4}
        />
        <Panel position="top-left">
          <div className="bg-card/95 flex flex-col gap-2.5 rounded-lg border p-3 text-xs shadow-sm backdrop-blur">
            {isEmpty && <span className="text-muted-foreground">{emptyHint}</span>}
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {(
                legendKinds ??
                (compact
                  ? (["begin", "goal", "group", "intent", "fact", "finding", "hint", "digest"] as ExploreKind[])
                  : (["begin", "goal", "intent", "fact", "finding", "hint", "digest"] as ExploreKind[]))
              ).map((k) => {
                const m = typeMeta[k];
                const Icon = m.icon;
                return (
                  <span key={k} className="text-foreground inline-flex items-center gap-1.5">
                    <span className={cn("flex size-4 items-center justify-center rounded", m.iconBg)}>
                      <Icon className="size-2.5 text-white" />
                    </span>
                    {m.label}
                  </span>
                );
              })}
            </div>
            {!compact && (
              <div className="border-border/60 text-muted-foreground flex flex-wrap gap-x-3 gap-y-1.5 border-t pt-2">
                {(legendRels ?? (Object.keys(relLabel) as Array<keyof typeof relLabel>)).map((k) => (
                  <span key={k} className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: relColor[k] }} />
                    {relLabel[k]}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </ReactFlow>
      </div>
      <NodeDetailPanel
        node={selected}
        nodesById={nodesById}
        onSelect={setSelected}
        onClose={() => setSelected(null)}
        onFocus={centerOnNode}
      />
    </div>
  );
}

// ExplorationGraph is the shared exploration / attack-chain graph canvas — used by the task graph
// tab (full graph, polled) and the finding lineage view (origin→finding subgraph).
export function ExplorationGraph({
  nodes,
  edges,
  className,
  emptyHint,
  fitViewOptions,
  legendKinds,
  legendRels,
  focusNodeId,
  fitView = true,
  compact = false,
}: {
  nodes: TaskNode[];
  edges: Edge[];
  className?: string;
  emptyHint?: string;
  fitViewOptions?: React.ComponentProps<typeof ReactFlow>["fitViewOptions"];
  legendKinds?: ExploreKind[];
  legendRels?: Array<keyof typeof relLabel>;
  focusNodeId?: string;
  fitView?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cn("w-full overflow-hidden rounded-xl", className)}>
      <ReactFlowProvider>
        <ExplorationGraphInner
          nodes={nodes}
          edges={edges}
          emptyHint={emptyHint}
          fitViewOptions={fitViewOptions}
          legendKinds={legendKinds}
          legendRels={legendRels}
          focusNodeId={focusNodeId}
          fitView={fitView}
          compact={compact}
        />
      </ReactFlowProvider>
    </div>
  );
}
