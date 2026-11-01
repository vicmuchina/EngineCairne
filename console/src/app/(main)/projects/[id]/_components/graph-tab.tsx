"use client";

import * as React from "react";

import { NetworkIcon } from "lucide-react";

import { ExplorationGraph } from "@/components/exploration-graph";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectDetail } from "@/lib/cairn-api";
import { plural } from "@/lib/cairn-format";
import { buildCairnGraph } from "@/lib/cairn-graph";

/**
 * The real Artex exploration graph, fed by the Cairn adapter. Cairn's
 * origin/goal premises render as Start and Goal, facts as Fact nodes, intents
 * as Intent nodes and hints as Hint nodes.
 */
export function GraphTab({
  detail,
  loading,
  focusNodeId,
}: {
  detail: ProjectDetail | null;
  loading: boolean;
  focusNodeId?: string;
}) {
  // Hash only the fields the graph renders, so a 4 s detail poll that changes
  // nothing (e.g. an activity heartbeat) does not rebuild the canvas and reset
  // layout. Genuine graph changes still produce a new signature and redraw.
  const graphSignature = React.useMemo(() => {
    if (!detail) return "";
    return JSON.stringify({
      status: detail.project.status,
      facts: detail.facts.map((f) => [f.id, f.description]),
      intents: detail.intents.map((i) => [i.id, i.worker, i.to, i.concluded_at, i.description, i.from]),
      hints: detail.hints.map((h) => [h.id, h.content]),
    });
  }, [detail]);

  // Read the latest detail through a ref: including `detail` in the deps would
  // rebuild the graph on every 4 s poll (new object identity) and reset the canvas.
  const detailRef = React.useRef(detail);
  detailRef.current = detail;
  const graph = React.useMemo(
    () => (detailRef.current ? buildCairnGraph(detailRef.current) : { nodes: [], edges: [] }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is the value that matters.
    [graphSignature],
  );
  const [showAll, setShowAll] = React.useState(true);
  const compact = !showAll && !focusNodeId;

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <NetworkIcon className="size-4 text-muted-foreground" />
          Exploration graph
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {loading
              ? "Loading graph…"
              : `${plural(graph.nodes.length, "node")} · ${plural(graph.edges.length, "edge")} · ${
                  focusNodeId
                    ? `focused on ${focusNodeId}`
                    : compact
                      ? "completed steps grouped · click a group to inspect"
                      : "full graph · use the minimap"
                }`}
          </span>
          {!focusNodeId && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? "Group completed" : `Show all ${graph.nodes.length}`}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-[calc(100dvh-13rem)] min-h-[420px] w-full rounded-none" />
      ) : (
        <div className="relative">
          <ExplorationGraph
            key={compact ? "compact" : "full"}
            nodes={graph.nodes}
            edges={graph.edges}
            className="h-[calc(100dvh-13rem)] min-h-[420px] w-full rounded-none"
            emptyHint="No exploration data yet."
            // Fit View and the initial render must genuinely fit every node.
            // When a Findings row asks for a node, fitView is disabled and the
            // graph centers that node at 1:1 instead.
            fitViewOptions={{ padding: 0.2, minZoom: 0.01, maxZoom: 1 }}
            legendKinds={compact ? ["begin", "goal", "group", "intent", "finding", "fact", "hint"] : ["begin", "goal", "intent", "finding", "fact", "hint"]}
            legendRels={["spawns", "derived_from", "yields"]}
            focusNodeId={focusNodeId}
            fitView={!focusNodeId}
            compact={compact}
          />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[#f0f2f7] to-transparent dark:from-neutral-950" />
        </div>
      )}
    </Card>
  );
}
