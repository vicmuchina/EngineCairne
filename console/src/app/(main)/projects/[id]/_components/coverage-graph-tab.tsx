"use client";

import * as React from "react";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
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

import { CheckIcon, FocusIcon, NetworkIcon, ShieldAlertIcon, WaypointsIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { CoverageGraphData, CoverageGraphNode, Entity, Finding, ProjectDetail } from "@/lib/cairn-api";
import { cairn } from "@/lib/cairn-api";
import { formatNumber, formatRelative, oneLine } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

import { KindBadge, KindDot, kindColor, kindLabel } from "./entity-kind";

const MAX_NODES = 300;
const COL_W = 250;
const ROW_H = 70;
const CHILD_COLS = 4;
const BLOCK_GAP = 90;
const BAND_ROWS = 8;

type CoverageNodeData = { node: CoverageGraphNode };
type CoverageRFNode = RFNode<CoverageNodeData, "coverage">;

function CoverageNodeCard({ data, selected }: NodeProps<CoverageRFNode>) {
  const node = data.node;
  const color = kindColor(node.kind);
  return (
    <div
      className={cn(
        "relative w-[200px] rounded-lg bg-card px-2.5 py-1.5 shadow-sm transition-shadow",
        node.tested ? "border-2" : "border border-dashed border-border",
        selected && "ring-2 ring-ring ring-offset-1",
      )}
      style={{
        borderColor: node.tested ? color.hex : undefined,
        opacity: node.in_scope ? 1 : 0.45,
      }}
      title={node.label || node.kind}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-slate-400" />
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-slate-400" />
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color.hex }} />
        <span className="truncate text-[11px] font-medium leading-4">{node.label || node.key}</span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-[9px] text-muted-foreground">
        <span className="truncate">{kindLabel(node.kind)}</span>
        <span className="shrink-0">{node.tested ? "tested" : "untested"}</span>
      </div>
    </div>
  );
}

const nodeTypes = { coverage: CoverageNodeCard };

function buildEdges(nodes: CoverageGraphNode[], explicit?: CoverageGraphData["edges"]) {
  const keys = new Set(nodes.map((node) => node.key));
  if (explicit?.length) {
    return explicit.filter((edge) => keys.has(edge.src) && keys.has(edge.dst));
  }
  return nodes
    .filter((node) => node.parent_id)
    .map((node) => ({ src: `e:${node.parent_id}`, dst: node.key }))
    .filter((edge) => keys.has(edge.src) && keys.has(edge.dst));
}

/**
 * Containment layout: each root (host/IP) owns a vertical block, its children (URLs)
 * fan out to the right in a small grid. Edges stay inside the block, so a project with
 * 100+ endpoints remains readable instead of a cross-hatched grid. Flat graphs (no
 * parent_id) fall back to a compact grid.
 */
function computeLayout(nodes: CoverageGraphNode[]): Map<string, { x: number; y: number }> {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const positions = new Map<string, { x: number; y: number }>();
  const children = new Map<string, CoverageGraphNode[]>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    const parentKey = `e:${node.parent_id}`;
    if (!byKey.has(parentKey) || parentKey === node.key) continue;
    const bucket = children.get(parentKey);
    if (bucket) bucket.push(node);
    else children.set(parentKey, [node]);
  }
  const roots = nodes
    .filter((node) => !node.parent_id || !byKey.has(`e:${node.parent_id}`))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

  const sortChildren = (list: CoverageGraphNode[]) =>
    [...list].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

  const flat = roots.length === nodes.length;
  if (flat) {
    nodes
      .slice()
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
      .forEach((node, index) => {
        const band = Math.floor(index / BAND_ROWS);
        const row = index % BAND_ROWS;
        positions.set(node.key, { x: band * COL_W, y: row * ROW_H });
      });
    return positions;
  }

  let cursorY = 0;
  for (const root of roots) {
    const kids = sortChildren(children.get(root.key) ?? []);
    const cols = Math.min(CHILD_COLS, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, kids.length)))));
    const rows = kids.length ? Math.ceil(kids.length / cols) : 1;
    positions.set(root.key, { x: 0, y: cursorY + ((rows - 1) * ROW_H) / 2 });
    kids.forEach((child, index) => {
      const column = index % cols;
      const row = Math.floor(index / cols);
      positions.set(child.key, {
        x: COL_W * (1 + column),
        y: cursorY + row * ROW_H,
      });
    });
    cursorY += rows * ROW_H + BLOCK_GAP;
  }
  // Any node whose parent was capped out still gets a deterministic slot.
  let extraY = cursorY;
  for (const node of nodes) {
    if (positions.has(node.key)) continue;
    positions.set(node.key, { x: COL_W, y: extraY });
    extraY += ROW_H;
  }
  return positions;
}

function localGraph(entities: Entity[]): CoverageGraphData {
  return {
    nodes: entities.map((entity) => ({
      key: `e:${entity.id}`,
      id: entity.id,
      kind: entity.kind,
      label: entity.label || entity.key,
      tested: entity.tested,
      in_scope: entity.in_scope,
      parent_id: entity.parent_id,
    })),
    edges: entities
      .filter((entity) => entity.parent_id)
      .map((entity) => ({ src: `e:${entity.parent_id}`, dst: `e:${entity.id}` })),
  };
}

function FactLinks({
  factIds,
  factCount,
  onOpenGraph,
  onClose,
}: {
  factIds: string[];
  factCount: number;
  onOpenGraph: (nodeId: string) => void;
  onClose: () => void;
}) {
  if (factIds.length > 0) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {factIds.map((factId) => (
          <button
            key={factId}
            type="button"
            className="inline-flex items-center gap-1 rounded-md border bg-muted/20 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
            onClick={() => {
              onOpenGraph(factId);
              onClose();
            }}
            title={`Open ${factId} in the exploration graph`}
          >
            {factId}
            <NetworkIcon className="size-3 text-muted-foreground" />
          </button>
        ))}
      </div>
    );
  }
  if (factCount > 0) {
    return (
      <p className="text-muted-foreground">
        {formatNumber(factCount)} linked fact{factCount === 1 ? "" : "s"} recorded. This engine does not expose their
        ids on the entity detail contract.
      </p>
    );
  }
  return <p className="text-muted-foreground">No facts linked yet.</p>;
}

function NodeDrawer({
  node,
  entity,
  findings,
  open,
  onOpenChange,
  onOpenGraph,
  onFocusEntity,
}: {
  node: CoverageGraphNode | null;
  entity: Entity | null;
  findings: Finding[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenGraph: (nodeId: string) => void;
  onFocusEntity: (entityId: string) => void;
}) {
  const entityFindings = React.useMemo(() => {
    if (!entity) return [];
    return findings.filter((finding) => finding.entity_id === entity.id || finding.entity_ids.includes(entity.id));
  }, [entity, findings]);
  const factIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const factId of entity?.facts ?? []) ids.add(factId);
    for (const finding of entityFindings) if (finding.fact_id) ids.add(finding.fact_id);
    return [...ids];
  }, [entity, entityFindings]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {!node ? (
          <div className="p-6 text-sm text-muted-foreground">No asset selected.</div>
        ) : (
          <>
            <SheetHeader className="border-b px-5 py-4 pr-12">
              <div className="flex flex-wrap items-center gap-2">
                <KindBadge kind={node.kind} />
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]",
                    node.tested
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "border-dashed text-muted-foreground",
                  )}
                >
                  {node.tested && <CheckIcon className="size-3" />}
                  {node.tested ? "Tested" : "Untested"}
                </span>
                {!node.in_scope && (
                  <span className="rounded-md border border-dashed px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    Out of scope
                  </span>
                )}
              </div>
              <SheetTitle className="mt-1 break-words text-base">{node.label || node.key}</SheetTitle>
              <SheetDescription className="break-all font-mono text-[11px]">
                {entity?.id ?? node.id ?? node.key}
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-5 px-5 py-4 text-xs">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Full key</div>
                  <div className="mt-0.5 break-all font-mono text-[11px]">{entity?.key ?? node.label ?? node.key}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Parent</div>
                  <div className="mt-0.5 font-mono text-[11px]">
                    {node.parent_id ?? <span className="font-sans text-muted-foreground">Root asset</span>}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</div>
                  <div className="mt-0.5 capitalize">{entity?.status ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</div>
                  <div className="mt-0.5">{entity?.source ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last seen</div>
                  <div className="mt-0.5" suppressHydrationWarning>
                    {entity ? formatRelative(entity.last_seen_at) : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Kind</div>
                  <div className="mt-0.5">{kindLabel(node.kind)}</div>
                </div>
              </div>

              <section>
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Metadata
                </h3>
                {entity && Object.keys(entity.metadata ?? {}).length > 0 ? (
                  <pre className="max-h-48 overflow-auto rounded-md border bg-muted/20 p-2.5 font-mono text-[10px] leading-relaxed">
                    {JSON.stringify(entity.metadata, null, 2)}
                  </pre>
                ) : (
                  <p className="text-muted-foreground">No metadata recorded.</p>
                )}
              </section>

              <section>
                <h3 className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Linked facts</span>
                  <span className="font-normal normal-case tracking-normal">
                    {formatNumber(entity?.fact_count ?? 0)}
                  </span>
                </h3>
                <FactLinks
                  factIds={factIds}
                  factCount={entity?.fact_count ?? 0}
                  onOpenGraph={onOpenGraph}
                  onClose={() => onOpenChange(false)}
                />
              </section>

              <section>
                <h3 className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Findings on this entity</span>
                  <span className="font-normal normal-case tracking-normal">{entityFindings.length}</span>
                </h3>
                {entityFindings.length > 0 ? (
                  <div className="divide-y rounded-md border">
                    {entityFindings.map((finding) => (
                      <div key={finding.id} className="flex items-start gap-2 px-3 py-2">
                        <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 font-medium text-foreground/90">
                            {oneLine(finding.title || finding.summary || finding.id)}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                            <span className="font-mono">{finding.id}</span>
                            {finding.severity && <span className="capitalize">{finding.severity}</span>}
                            <span className="capitalize">{finding.status.replace(/[_-]/g, " ")}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">No findings linked to this entity.</p>
                )}
              </section>

              {entity && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() => {
                    onFocusEntity(entity.id);
                    onOpenChange(false);
                  }}
                >
                  <FocusIcon data-icon="inline-start" />
                  Focus in Test assets
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CoverageGraphInner({
  graph,
  entities,
  findings,
  onOpenGraph,
  onFocusEntity,
}: {
  graph: CoverageGraphData;
  entities: Entity[];
  findings: Finding[];
  onOpenGraph: (nodeId: string) => void;
  onFocusEntity: (entityId: string) => void;
}) {
  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized({ includeHiddenNodes: true });
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<CoverageRFNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const hasChildren = graph.nodes.some((node) => node.parent_id);
  const rootCount = graph.nodes.filter((node) => !node.parent_id).length;
  const [scope, setScope] = React.useState<"top" | "all">(
    hasChildren && graph.nodes.length > 60 ? "top" : "all",
  );
  const userScope = React.useRef(false);
  React.useEffect(() => {
    if (userScope.current) return;
    setScope(hasChildren && graph.nodes.length > 60 ? "top" : "all");
  }, [graph.nodes.length, hasChildren]);

  const capped = React.useMemo(() => {
    const pool = scope === "top" ? graph.nodes.filter((node) => !node.parent_id) : graph.nodes;
    const nodes = pool.slice(0, MAX_NODES);
    const keys = new Set(nodes.map((node) => node.key));
    const edges = buildEdges(nodes, graph.edges).filter((edge) => keys.has(edge.src) && keys.has(edge.dst));
    return { nodes, edges, total: graph.nodes.length, shown: nodes.length };
  }, [graph, scope]);

  const layout = React.useMemo(() => computeLayout(capped.nodes), [capped.nodes]);
  const entitiesById = React.useMemo(() => new Map(entities.map((entity) => [entity.id, entity])), [entities]);
  const selectedNode = selectedKey ? (graph.nodes.find((node) => node.key === selectedKey) ?? null) : null;
  const selectedEntity =
    selectedNode?.id !== null && selectedNode?.id !== undefined ? (entitiesById.get(selectedNode.id) ?? null) : null;

  React.useEffect(() => {
    setRfNodes(
      capped.nodes.map((node) => ({
        id: node.key,
        type: "coverage" as const,
        position: layout.get(node.key) ?? { x: 0, y: 0 },
        data: { node },
        selected: node.key === selectedKey,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
      })),
    );
    setRfEdges(
      capped.edges.map((edge, index) => ({
        id: `edge-${index}-${edge.src}-${edge.dst}`,
        source: edge.src,
        target: edge.dst,
        type: "default",
        style: { stroke: "#64748b", strokeWidth: 1, strokeOpacity: 0.55 },
      })),
    );
  }, [capped, layout, selectedKey, setRfNodes, setRfEdges]);

  const fitKey = React.useRef("");
  React.useEffect(() => {
    if (!nodesInitialized || rfNodes.length === 0) return;
    const key = `${scope}:${rfNodes.length}:${rfNodes[0]?.id ?? ""}`;
    if (fitKey.current === key) return;
    fitKey.current = key;
    // Nodes mount in one commit but React Flow measures them asynchronously.
    // Re-fit at a few delays so the final bounds (not the first partial set)
    // determine the initial viewport.
    const timers = [0, 150, 500].map((delay) =>
      window.setTimeout(() => flow.fitView({ padding: 0.08, minZoom: 0.12, maxZoom: 1.1, duration: 0 }), delay),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [flow, nodesInitialized, rfNodes]);

  return (
    <div className="relative h-[clamp(420px,calc(100dvh-17rem),900px)] w-full">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => setSelectedKey(node.id)}
        onPaneClick={() => setSelectedKey(null)}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.02}
        maxZoom={2}
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
          className="!rounded-lg !border !shadow-sm [&>button]:!border-border [&>button]:!bg-card [&>button:hover]:!bg-accent [&_svg]:!fill-foreground"
        />
        <MiniMap
          pannable
          zoomable
          className="!rounded-lg !border !shadow-sm !bg-card"
          maskColor="rgb(148 163 184 / 0.18)"
          nodeColor={(node) => kindColor((node.data as CoverageNodeData | undefined)?.node?.kind ?? "unknown").hex}
          nodeStrokeWidth={0}
          nodeBorderRadius={4}
        />
        <Panel position="top-right">
          <div className="flex flex-col gap-1.5 rounded-lg border bg-card/95 p-2.5 text-[10px] shadow-sm backdrop-blur">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-sm border-2 border-slate-500" /> Tested
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-sm border border-dashed border-slate-500" /> Untested
              </span>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="size-3 rounded-sm border bg-muted opacity-45" /> Out of scope
              </span>
            </div>
            {hasChildren && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    userScope.current = true;
                    setScope("top");
                  }}
                  className={cn(
                    "rounded border px-1.5 py-0.5",
                    scope === "top" ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  Top-level {formatNumber(rootCount)}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    userScope.current = true;
                    setScope("all");
                  }}
                  className={cn(
                    "rounded border px-1.5 py-0.5",
                    scope === "all" ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  All {formatNumber(capped.total)}
                </button>
              </div>
            )}
            <span className="text-muted-foreground">
              {formatNumber(capped.shown)} of {formatNumber(capped.total)} assets
              {capped.total > MAX_NODES && scope === "all" ? ` · showing ${MAX_NODES}` : ""}
            </span>
          </div>
        </Panel>
      </ReactFlow>

      <NodeDrawer
        node={selectedNode}
        entity={selectedEntity}
        findings={findings}
        open={selectedNode !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedKey(null);
        }}
        onOpenGraph={onOpenGraph}
        onFocusEntity={onFocusEntity}
      />
    </div>
  );
}

export function CoverageGraphTab({
  projectId,
  detail,
  loading,
  onOpenGraph,
  onFocusEntity,
}: {
  projectId: string;
  detail: ProjectDetail | null;
  loading: boolean;
  onOpenGraph: (nodeId: string) => void;
  onFocusEntity: (entityId: string) => void;
}) {
  const entities = React.useMemo(() => detail?.entities ?? [], [detail]);
  const findings = React.useMemo(() => detail?.findings ?? [], [detail]);
  const coverage = detail?.coverage ?? null;

  const signature = React.useMemo(
    () =>
      entities
        .map((entity) =>
          [entity.id, entity.parent_id, entity.kind, entity.tested, entity.in_scope, entity.label].join(":"),
        )
        .join("|"),
    [entities],
  );

  const [graph, setGraph] = React.useState<CoverageGraphData | null>(null);
  const [graphLoading, setGraphLoading] = React.useState(true);
  const [graphError, setGraphError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // `signature` is intentionally a trigger: entity edits must refetch the graph.
    void signature;
    let alive = true;
    setGraphLoading(true);
    cairn
      .getCoverageGraph(projectId)
      .then((data) => {
        if (!alive) return;
        setGraph(data);
        setGraphError(null);
      })
      .catch((cause) => {
        if (!alive) return;
        setGraph(null);
        setGraphError((cause as Error).message);
      })
      .finally(() => {
        if (alive) setGraphLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, signature]);

  const fallback = React.useMemo(() => localGraph(entities), [entities]);
  const data = graph ?? fallback;
  const byKind = coverage?.by_kind ?? [];
  const kindTotal = byKind.reduce((total, row) => total + row.total, 0);
  const legendKinds = React.useMemo(
    () => [...byKind].sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind)).slice(0, 8),
    [byKind],
  );
  const pctLabel = coverage?.pct !== null && coverage?.pct !== undefined ? `${Math.round(coverage.pct * 100)}%` : "—";

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <WaypointsIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-semibold">Asset coverage</span>
            <span className="text-[11px] text-muted-foreground">
              {loading ? "loading…" : `${formatNumber(entities.length)} assets · ${formatNumber(byKind.length)} kinds`}
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {graphError ? "containment snapshot" : "entity containment from parent ids"}
          </span>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Coverage</div>
              <div className="text-2xl font-semibold tabular-nums tracking-tight">{pctLabel}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Tested</div>
              <div className="text-sm font-medium tabular-nums">
                {formatNumber(coverage?.tested ?? entities.filter((entity) => entity.tested).length)}/
                {formatNumber(coverage?.denominator ?? entities.filter((entity) => entity.in_scope).length)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">In scope rows</div>
              <div className="text-sm font-medium tabular-nums">{formatNumber(coverage?.scope_rows ?? 0)}</div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Per kind</span>
                {kindTotal > 0 && <span>solid = tested</span>}
              </div>
              {byKind.length > 0 ? (
                <div className="flex h-2.5 w-full overflow-hidden rounded-full border bg-muted/30">
                  {byKind.map((row) => (
                    <div
                      key={row.kind}
                      className="relative h-full min-w-[2px]"
                      style={{
                        width: `${kindTotal > 0 ? (row.total / kindTotal) * 100 : 0}%`,
                        backgroundColor: kindColor(row.kind).soft,
                      }}
                      title={`${kindLabel(row.kind)}: ${row.tested}/${row.total} tested`}
                    >
                      <div
                        className="h-full"
                        style={{
                          width: `${row.total > 0 ? (row.tested / row.total) * 100 : 0}%`,
                          backgroundColor: kindColor(row.kind).hex,
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-2.5 w-full rounded-full border bg-muted/30" />
              )}
            </div>
          </div>

          {byKind.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {legendKinds.map((row) => (
                <span key={row.kind} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <KindDot kind={row.kind} />
                  {kindLabel(row.kind)}
                  <span className="tabular-nums text-foreground">
                    {row.tested}/{row.total}
                  </span>
                </span>
              ))}
              {byKind.length > legendKinds.length && (
                <span className="text-[10px] text-muted-foreground">+{byKind.length - legendKinds.length} kinds</span>
              )}
            </div>
          )}
        </div>
      </Card>

      {graphError && (
        <div className="rounded-lg border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          The coverage graph endpoint is unavailable; showing the entity containment snapshot instead.{" "}
          <span className="font-mono">{graphError}</span>
        </div>
      )}

      <Card className="gap-0 overflow-hidden p-0">
        {graphLoading && !graph && entities.length === 0 ? (
          <div className="h-[clamp(420px,calc(100dvh-17rem),900px)] w-full animate-pulse bg-muted/20" />
        ) : data.nodes.length === 0 ? (
          <div className="px-4 py-16 text-center text-xs text-muted-foreground">No assets recorded yet.</div>
        ) : (
          <ReactFlowProvider>
            <CoverageGraphInner
              graph={data}
              entities={entities}
              findings={findings}
              onOpenGraph={onOpenGraph}
              onFocusEntity={onFocusEntity}
            />
          </ReactFlowProvider>
        )}
      </Card>
    </div>
  );
}
