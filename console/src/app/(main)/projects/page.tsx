"use client";

import * as React from "react";

import Link from "next/link";

import {
  ActivityIcon,
  ArrowUpRightIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCairnProjects } from "@/hooks/use-cairn";
import { findingCount, type ProjectStatus, projectTotals } from "@/lib/cairn-api";
import { formatDate, formatNumber, formatRelative, plural } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | ProjectStatus;
type SortKey = "created" | "title" | "facts" | "intents";

const SORT_LABELS: Record<SortKey, string> = {
  created: "Newest first",
  title: "Title A–Z",
  facts: "Most findings",
  intents: "Most intents",
};

function SummaryCard({
  icon: Icon,
  label,
  value,
  loading,
  children,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="min-h-[7.25rem] justify-between gap-2">
      <CardHeader className="pb-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight">
          {loading ? <Skeleton className="h-9 w-12" /> : formatNumber(value)}
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">{children}</CardContent>
    </Card>
  );
}

export default function ProjectsPage() {
  const { projects, loading, refreshing, error, updatedAt, refresh } = useCairnProjects(15000);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [sort, setSort] = React.useState<SortKey>("created");

  const totals = React.useMemo(() => projectTotals(projects), [projects]);
  const bootstrapOn = React.useMemo(() => projects.filter((project) => project.bootstrap_enabled).length, [projects]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = projects.filter((project) => {
      if (status !== "all" && project.status !== status) return false;
      if (!needle) return true;
      return (
        project.title.toLowerCase().includes(needle) ||
        project.id.toLowerCase().includes(needle) ||
        (project.reason?.worker ?? "").toLowerCase().includes(needle)
      );
    });
    switch (sort) {
      case "title":
        return filtered.sort((a, b) => a.title.localeCompare(b.title));
      case "facts":
        return filtered.sort((a, b) => findingCount(b) - findingCount(a));
      case "intents":
        return filtered.sort((a, b) => b.intent_count - a.intent_count);
      default:
        return filtered.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }
  }, [projects, query, status, sort]);

  return (
    <div className="flex flex-1 flex-col gap-6 pb-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {loading
              ? "Loading Cairn projects…"
              : `${plural(totals.projects, "project")} · ${formatNumber(totals.active)} active · ${plural(totals.facts, "finding")} · ${plural(totals.intents, "intent")}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {updatedAt ? `updated ${formatRelative(updatedAt.toISOString())}` : "…"}
          </span>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCwIcon data-icon="inline-start" className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <FolderKanbanIcon />
          <AlertTitle>Cairn API unreachable</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-[11px]">{error}</span>
            {projects.length > 0 && (
              <span className="block text-xs text-muted-foreground">Showing the last successful snapshot.</span>
            )}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* ── Summary ── */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <SummaryCard icon={FolderKanbanIcon} label="Projects" value={totals.projects} loading={loading}>
          <span className="text-emerald-500">active {formatNumber(totals.active)}</span>
          <span className="text-amber-500">stopped {formatNumber(totals.stopped)}</span>
          <span className="text-blue-500">completed {formatNumber(totals.completed)}</span>
        </SummaryCard>

        <SummaryCard icon={ActivityIcon} label="Active projects" value={totals.active} loading={loading}>
          <span className="text-muted-foreground">bootstrap on {formatNumber(bootstrapOn)}</span>
        </SummaryCard>

        <SummaryCard icon={SparklesIcon} label="Findings" value={totals.facts} loading={loading}>
          <span className="text-muted-foreground">across {plural(totals.projects, "project")}</span>
        </SummaryCard>

        <SummaryCard icon={GitBranchIcon} label="Intents" value={totals.intents} loading={loading}>
          <span className="text-blue-400">working {formatNumber(totals.working)}</span>
          <span className="text-slate-400">unclaimed {formatNumber(totals.unclaimed)}</span>
        </SummaryCard>
      </div>

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by title or id…"
            className="h-9 pl-8 text-xs"
            aria-label="Filter projects"
          />
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          value={status}
          onValueChange={(value) => {
            if (value) setStatus(value as StatusFilter);
          }}
        >
          <ToggleGroupItem value="all" className="text-xs">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="active" className="text-xs">
            Active
          </ToggleGroupItem>
          <ToggleGroupItem value="stopped" className="text-xs">
            Stopped
          </ToggleGroupItem>
          <ToggleGroupItem value="completed" className="text-xs">
            Completed
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-2">
          <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
            <SelectTrigger size="sm" className="h-9 w-44 text-xs" aria-label="Sort projects">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <SelectItem key={key} value={key} className="text-xs">
                  {SORT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Table ── */}
      <Card className="gap-0 overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              {["Project", "Status", "Findings", "Intents", "Working", "Unclaimed", "Hints", "Created"].map((heading) => (
                <TableHead key={heading} className="px-4 py-3 text-xs font-medium text-muted-foreground">
                  {heading}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <TableRow key={`skeleton-${index.toString()}`}>
                  <TableCell colSpan={8} className="px-4 py-3">
                    <Skeleton className="h-4 w-full max-w-lg" />
                  </TableCell>
                </TableRow>
              ))
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="px-4 py-10">
                  {projects.length === 0 ? (
                    <Empty className="border">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <FolderKanbanIcon />
                        </EmptyMedia>
                        <EmptyTitle>No projects yet</EmptyTitle>
                        <EmptyDescription>
                          Projects created through the Cairn CLI or Alpine UI appear here automatically.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <div className="text-center text-xs text-muted-foreground">
                      No projects match this filter.
                      <Button
                        size="sm"
                        variant="link"
                        className="ml-1 h-auto px-1 text-xs"
                        onClick={() => {
                          setQuery("");
                          setStatus("all");
                        }}
                      >
                        Clear filters
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((project) => (
                <TableRow key={project.id} className="transition-colors hover:bg-muted/40">
                  <TableCell className="max-w-xs px-4 py-3">
                    <Link prefetch={false} href={`/projects/${project.id}`} className="group flex flex-col">
                      <span className="flex items-center gap-1 truncate text-sm font-medium group-hover:underline">
                        {project.title}
                        <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </span>
                      <span className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{project.id}</span>
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <StatusBadge domain="project" value={project.status} dot className="px-2 py-0.5 text-[11px]" />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs tabular-nums">{formatNumber(findingCount(project))}</TableCell>
                  <TableCell className="px-4 py-3 text-xs tabular-nums">{formatNumber(project.intent_count)}</TableCell>
                  <TableCell className="px-4 py-3 text-xs tabular-nums">
                    {project.working_intent_count > 0 ? (
                      <span className="font-semibold text-blue-400">{formatNumber(project.working_intent_count)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs tabular-nums">
                    {project.unclaimed_intent_count > 0 ? (
                      formatNumber(project.unclaimed_intent_count)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs tabular-nums">
                    {project.hint_count > 0 ? formatNumber(project.hint_count) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell
                    className="px-4 py-3 text-xs tabular-nums text-muted-foreground"
                    title={formatDate(project.created_at)}
                  >
                    {formatRelative(project.created_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <div className="text-xs text-muted-foreground">
        {loading ? "Loading…" : `${formatNumber(visible.length)} of ${plural(projects.length, "project")} shown`}
      </div>
    </div>
  );
}
