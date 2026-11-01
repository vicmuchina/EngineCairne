"use client";

import * as React from "react";

import {
  ChevronDownIcon,
  FlaskConicalIcon,
  NetworkIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { Fact, Intent, ProjectDetail } from "@/lib/cairn-api";
import { FirstClassFindings } from "./first-class-findings";
import { formatRelative, idOrdinal, oneLine } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

const PREMISES = new Set(["origin", "goal"]);
type ProducerFilter = "all" | "agent" | "bootstrap";
type SortOrder = "newest" | "oldest";

function producerOf(producer: Intent | undefined): string {
  if (!producer) return "bootstrap";
  return producer.worker ?? producer.creator;
}

function FactsRow({
  fact,
  producer,
  expanded,
  onToggle,
  onOpenGraph,
}: {
  fact: Fact;
  producer?: Intent;
  expanded: boolean;
  onToggle: () => void;
  onOpenGraph: (nodeId: string) => void;
}) {
  const timestamp = producer?.concluded_at ?? null;
  return (
    <div className={cn("border-b last:border-0", expanded && "bg-muted/15")}>
      <div className="flex items-start gap-3 px-4 py-3">
        <Badge
          variant="outline"
          className="mt-0.5 flex w-12 shrink-0 justify-center px-1.5 py-0 font-mono text-[11px]"
        >
          {fact.id}
        </Badge>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="block w-full text-left"
          >
            <div className="line-clamp-2 min-h-[2.4rem] text-xs leading-relaxed text-foreground/90">
              {oneLine(fact.description)}
            </div>
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {producer ? (
              <>
                <span>{producerOf(producer)}</span>
                <button
                  type="button"
                  onClick={() => onOpenGraph(producer.id)}
                  className="font-mono underline-offset-2 hover:text-foreground hover:underline"
                  title={`Open ${producer.id} in the exploration graph`}
                >
                  {producer.id}
                </button>
                <span className="text-muted-foreground/50">·</span>
                <span>{timestamp ? formatRelative(timestamp) : "no timestamp"}</span>
              </>
            ) : (
              <span>bootstrap · no producing intent</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-7"
            onClick={() => onOpenGraph(fact.id)}
            aria-label={`Open ${fact.id} in the exploration graph`}
            title="Open in graph"
          >
            <NetworkIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-7"
            onClick={onToggle}
            aria-label={expanded ? "Collapse finding" : "Expand finding"}
            aria-expanded={expanded}
          >
            <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 pl-[4.75rem]">
          <div className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-3 text-xs leading-relaxed text-foreground/90">
            {fact.description}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => onOpenGraph(fact.id)}>
              <NetworkIcon data-icon="inline-start" />
              Open fact in graph
            </Button>
            {producer && (
              <Button size="sm" variant="outline" onClick={() => onOpenGraph(producer.id)}>
                <FlaskConicalIcon data-icon="inline-start" />
                Open producer {producer.id}
              </Button>
            )}
            <span className="text-[11px] text-muted-foreground">
              {producer
                ? `Produced by ${producerOf(producer)}${timestamp ? ` · ${formatRelative(timestamp)}` : ""}`
                : "Bootstrap fact (no producing intent)"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function FindingsTab({
  projectId,
  detail,
  loading,
  onOpenGraph,
  onOpenRetests,
  onRefresh,
}: {
  projectId?: string;
  detail: ProjectDetail | null;
  loading: boolean;
  onOpenGraph: (nodeId: string) => void;
  onOpenRetests?: () => void;
  onRefresh?: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [producerFilter, setProducerFilter] = React.useState<ProducerFilter>("all");
  const [sort, setSort] = React.useState<SortOrder>("newest");
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());

  const producerByFact = React.useMemo(() => {
    const map = new Map<string, Intent>();
    for (const intent of detail?.intents ?? []) {
      if (intent.to) map.set(intent.to, intent);
    }
    return map;
  }, [detail]);

  const premises = React.useMemo(
    () => (detail?.facts ?? []).filter((fact) => PREMISES.has(fact.id)),
    [detail],
  );
  const findings = React.useMemo(
    () => (detail?.facts ?? []).filter((fact) => !PREMISES.has(fact.id)),
    [detail],
  );

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = findings.filter((fact) => {
      const producer = producerByFact.get(fact.id);
      if (producerFilter === "agent" && !producer) return false;
      if (producerFilter === "bootstrap" && producer) return false;
      if (!needle) return true;
      return (
        fact.id.toLowerCase().includes(needle) ||
        fact.description.toLowerCase().includes(needle) ||
        (producer?.id ?? "").toLowerCase().includes(needle) ||
        (producer ? producerOf(producer) : "bootstrap").toLowerCase().includes(needle)
      );
    });
    const direction = sort === "newest" ? -1 : 1;
    return [...matched].sort((a, b) => (idOrdinal(a.id) - idOrdinal(b.id)) * direction);
  }, [findings, producerByFact, producerFilter, query, sort]);

  const filtersActive = query.trim() !== "" || producerFilter !== "all";

  // First-class findings (the generalized Artex model) take precedence. A project that
  // only has facts keeps the derived view below, so old projects still render.
  if ((detail?.findings?.length ?? 0) > 0 && projectId) {
    return (
      <FirstClassFindings
        projectId={projectId}
        detail={detail}
        onOpenGraph={onOpenGraph}
        onOpenRetests={onOpenRetests ?? (() => {})}
        onRefresh={onRefresh ?? (() => {})}
      />
    );
  }

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FlaskConicalIcon className="size-4 text-muted-foreground" />
            Premises
          </div>
          <span className="text-xs text-muted-foreground">{premises.length} facts</span>
        </div>
        {loading ? (
          <div className="px-4 py-4">
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <div className="divide-y">
            {premises.map((fact) => (
              <div key={fact.id} className="flex items-start gap-3 px-4 py-2.5">
                <Badge variant="outline" className="mt-0.5 w-14 shrink-0 justify-center px-1.5 py-0 text-[11px] capitalize">
                  {fact.id}
                </Badge>
                <p className="line-clamp-2 min-w-0 flex-1 text-xs leading-relaxed text-foreground/90">
                  {oneLine(fact.description)}
                </p>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 shrink-0"
                  onClick={() => onOpenGraph(fact.id)}
                  aria-label={`Open ${fact.id} in the exploration graph`}
                  title="Open in graph"
                >
                  <NetworkIcon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <SparklesIcon className="size-4 text-muted-foreground" />
            Findings
          </div>
          <span className="text-xs text-muted-foreground">
            {loading ? "…" : `${findings.length} findings · ${premises.length} premises`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          <div className="relative min-w-48 flex-1 sm:max-w-xs">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search findings…"
              className="h-8 pl-8 text-xs"
              aria-label="Search findings"
            />
          </div>
          <Select value={producerFilter} onValueChange={(value) => setProducerFilter(value as ProducerFilter)}>
            <SelectTrigger size="sm" className="h-8 w-40 text-xs" aria-label="Filter findings by producer">
              <SelectValue placeholder="Producer" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                All producers
              </SelectItem>
              <SelectItem value="agent" className="text-xs">
                Agent-produced
              </SelectItem>
              <SelectItem value="bootstrap" className="text-xs">
                Unattributed
              </SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(value) => setSort(value as SortOrder)}>
            <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Sort findings">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest" className="text-xs">
                Newest first
              </SelectItem>
              <SelectItem value="oldest" className="text-xs">
                Oldest first
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {loading ? "" : `${visible.length} shown`}
          </span>
        </div>

        {loading ? (
          <div className="divide-y">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={`finding-row-skeleton-${index.toString()}`} className="px-4 py-3">
                <Skeleton className="h-4 w-full max-w-xl" />
                <Skeleton className="mt-2 h-3 w-1/3" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-muted-foreground">
            {findings.length === 0 ? "No findings recorded yet." : "No findings match this search or filter."}
            {filtersActive && findings.length > 0 && (
              <Button
                size="sm"
                variant="link"
                className="ml-1 h-auto px-1 text-xs"
                onClick={() => {
                  setQuery("");
                  setProducerFilter("all");
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div>
            {visible.map((fact) => (
              <FactsRow
                key={fact.id}
                fact={fact}
                producer={producerByFact.get(fact.id)}
                expanded={expanded.has(fact.id)}
                onToggle={() => toggleExpanded(fact.id)}
                onOpenGraph={onOpenGraph}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
