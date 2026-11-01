"use client";

import * as React from "react";

import Link from "next/link";

import {
  ActivityIcon,
  ArrowUpRightIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  LightbulbIcon,
  LoaderIcon,
  RefreshCwIcon,
  ServerIcon,
  SparklesIcon,
} from "lucide-react";

import { CairnActivityFeed } from "@/components/cairn-activity-feed";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useCairnProjects, useRecentProjectActivity } from "@/hooks/use-cairn";
import { findingCount, type ProjectActivityItem, projectTotals } from "@/lib/cairn-api";
import { formatNumber, formatRelative, oneLine, plural } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

// ── helpers ──────────────────────────────────────────────────────────────────

const RECENT_LIMIT = 6;
const ACTIVITY_LIMIT = 6;

function LiveDot({ className }: { className?: string }) {
  return <span className={cn("inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500", className)} />;
}

function KpiCard({
  icon: Icon,
  label,
  value,
  loading,
  children,
  className,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  loading: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("min-h-[7.25rem] justify-between gap-2", className)}>
      <CardHeader className="pb-0">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight">
          {loading ? <Skeleton className="h-9 w-12" /> : formatNumber(value)}
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
        {loading ? <Skeleton className="h-3 w-24" /> : children}
      </CardContent>
    </Card>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  meta,
  action,
}: {
  icon: React.ElementType;
  title: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {meta}
        {action}
      </div>
    </div>
  );
}

function byCreatedDesc(a: { created_at: string }, b: { created_at: string }) {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { projects, loading, refreshing, error, refresh } = useCairnProjects(15000);
  const projectIds = React.useMemo(
    () => [...projects].sort(byCreatedDesc).map((project) => project.id),
    [projects],
  );
  const projectTitles = React.useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const {
    items: activity,
    loading: activityLoading,
    error: activityError,
    updatedAt: activityUpdatedAt,
    refresh: refreshActivity,
  } = useRecentProjectActivity(projectIds, { pollMs: 15000 });

  const totals = React.useMemo(() => projectTotals(projects), [projects]);
  const hintProjects = React.useMemo(() => projects.filter((p) => p.hint_count > 0).length, [projects]);

  const recentFindings = React.useMemo(
    () => activity.filter((item) => item.kind === "fact" && item.id !== "fact:origin").slice(0, RECENT_LIMIT),
    [activity],
  );
  const recentIntents = React.useMemo(
    () => activity.filter((item) => item.kind === "intent").slice(0, RECENT_LIMIT),
    [activity],
  );
  const recentProjects = React.useMemo(() => [...projects].sort(byCreatedDesc).slice(0, RECENT_LIMIT), [projects]);

  const feedError = error ?? activityError;
  const hasData = projects.length > 0;
  const showEmpty = !loading && !error && !hasData;
  const panelsLoading = loading || (activityLoading && activity.length === 0);

  return (
    <div className="flex flex-1 flex-col gap-6 pb-6">
      {/* ── Header ── */}
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">Live state of every Cairn project, finding and intent.</p>
      </div>

      {feedError && (
        <Alert variant="destructive">
          <ServerIcon />
          <AlertTitle>{error ? "Cairn API unreachable" : "Activity feed unavailable"}</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-[11px]">{feedError}</span>
            {hasData && <span className="block text-xs text-muted-foreground">Showing the last successful snapshot.</span>}
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void refresh();
                void refreshActivity();
              }}
              disabled={refreshing}
            >
              <RefreshCwIcon data-icon="inline-start" />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* ── KPI row ── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-6 xl:grid-cols-5">
        <KpiCard
          icon={FolderKanbanIcon}
          label="Projects"
          value={totals.projects}
          loading={loading}
          className="sm:col-span-2 xl:col-span-1"
        >
          <span className="text-emerald-500">active {formatNumber(totals.active)}</span>
          <span className="text-amber-500">stopped {formatNumber(totals.stopped)}</span>
          <span className="text-blue-500">completed {formatNumber(totals.completed)}</span>
        </KpiCard>

        <KpiCard
          icon={SparklesIcon}
          label="Findings"
          value={totals.facts}
          loading={loading}
          className="sm:col-span-2 xl:col-span-1"
        >
          <span className="text-muted-foreground">across {plural(totals.projects, "project")}</span>
        </KpiCard>

        <KpiCard
          icon={GitBranchIcon}
          label="Intents"
          value={totals.intents}
          loading={loading}
          className="sm:col-span-2 xl:col-span-1"
        >
          <span className="text-blue-400">working {formatNumber(totals.working)}</span>
          <span className="text-slate-400">unclaimed {formatNumber(totals.unclaimed)}</span>
        </KpiCard>

        <KpiCard
          icon={LightbulbIcon}
          label="Hints"
          value={totals.hints}
          loading={loading}
          className="sm:col-span-2 sm:col-start-2 xl:col-span-1 xl:col-start-auto"
        >
          <span className="text-muted-foreground">{plural(hintProjects, "project")} with hints</span>
        </KpiCard>

        <KpiCard
          icon={LoaderIcon}
          label="Open intents"
          value={totals.open}
          loading={loading}
          className="sm:col-span-2 sm:col-start-4 xl:col-span-1 xl:col-start-auto"
        >
          <span className="text-emerald-500">{formatNumber(totals.concluded)} concluded</span>
        </KpiCard>
      </div>

      {showEmpty ? (
        <Card className="p-2">
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderKanbanIcon />
              </EmptyMedia>
              <EmptyTitle>No Cairn projects yet</EmptyTitle>
              <EmptyDescription>
                Projects created through the Cairn CLI or Alpine UI appear here automatically.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" variant="outline" asChild>
                <a href="http://127.0.0.1:8000/" target="_blank" rel="noreferrer">
                  Open Cairn Alpine UI
                  <ArrowUpRightIcon data-icon="inline-end" />
                </a>
              </Button>
            </EmptyContent>
          </Empty>
        </Card>
      ) : (
        <>
          {/* ── Live activity + side column ── */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="gap-0 overflow-hidden p-0 xl:col-span-2">
              <PanelHeader
                icon={ActivityIcon}
                title="Live activity"
                meta={
                  <>
                    {!feedError && <LiveDot />}
                    <span>{formatNumber(activity.length)} recent events</span>
                    <span>{activityUpdatedAt ? `updated ${formatRelative(activityUpdatedAt.toISOString())}` : "loading…"}</span>
                  </>
                }
              />
              <div className="px-4">
                {panelsLoading ? (
                  <div className="divide-y">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <div key={`activity-skeleton-${index.toString()}`} className="py-3">
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="mt-2 h-3 w-full" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <CairnActivityFeed
                    items={activity.slice(0, ACTIVITY_LIMIT)}
                    projectTitles={projectTitles}
                    linkProject
                    empty={hasData ? "No activity recorded for the latest projects." : "No activity yet."}
                  />
                )}
              </div>
              <div className="mt-auto flex items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
                <span>
                  Latest {formatNumber(Math.min(activity.length, ACTIVITY_LIMIT))} of{" "}
                  {formatNumber(activity.length)} recent events
                </span>
                <Link
                  prefetch={false}
                  href="/projects"
                  className="flex items-center gap-0.5 hover:text-foreground"
                >
                  Open a project for the full timeline
                  <ArrowUpRightIcon className="size-3.5" />
                </Link>
              </div>
            </Card>

            <div className="flex flex-col gap-6">
              <Card className="gap-0 overflow-hidden p-0">
                <PanelHeader
                  icon={FolderKanbanIcon}
                  title="Recent projects"
                  action={
                    <Link
                      prefetch={false}
                      href="/projects"
                      className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      All
                      <ArrowUpRightIcon className="size-3.5" />
                    </Link>
                  }
                />
                <div className="flex flex-col divide-y">
                  {loading ? (
                    Array.from({ length: 3 }).map((_, index) => (
                      <div key={`project-skeleton-${index.toString()}`} className="px-4 py-3">
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="mt-2 h-3 w-2/3" />
                      </div>
                    ))
                  ) : recentProjects.length === 0 ? (
                    <div className="px-4 py-10 text-center text-xs text-muted-foreground">No projects yet.</div>
                  ) : (
                    recentProjects.map((project) => (
                      <Link
                        key={project.id}
                        prefetch={false}
                        href={`/projects/${project.id}`}
                        className="group flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium group-hover:underline">{project.title}</div>
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{project.id}</div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {formatNumber(findingCount(project))} findings · {formatNumber(project.intent_count)} intents
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <StatusBadge domain="project" value={project.status} dot className="px-1.5 py-0 text-[11px]" />
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            {formatRelative(project.created_at)}
                          </span>
                        </div>
                      </Link>
                    ))
                  )}
                </div>
              </Card>

              <Card className="gap-0 overflow-hidden p-0">
                <PanelHeader
                  icon={GitBranchIcon}
                  title="Recent intents"
                  meta={<span>{plural(totals.intents, "intent")}</span>}
                />
                <div className="px-4">
                  {panelsLoading ? (
                    <div className="divide-y">
                      {Array.from({ length: 3 }).map((_, index) => (
                        <div key={`intent-skeleton-${index.toString()}`} className="py-3">
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="mt-2 h-3 w-1/2" />
                        </div>
                      ))}
                    </div>
                  ) : recentIntents.length === 0 ? (
                    <div className="py-10 text-center text-xs text-muted-foreground">
                      {hasData ? "No intents recorded for the latest projects." : "No intents yet."}
                    </div>
                  ) : (
                    <div className="divide-y">
                      {recentIntents.map((intent: ProjectActivityItem) => (
                        <Link
                          key={`${intent.id}-${intent.cursor ?? ""}`}
                          prefetch={false}
                          href={`/projects/${intent.project_id}`}
                          className="-mx-2 flex items-start gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                        >
                          <StatusBadge
                            domain="cairnFeed"
                            value={intent.status ?? "open"}
                            dot
                            className="mt-0.5 shrink-0 px-1.5 py-0 text-[11px]"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="line-clamp-2 text-xs leading-snug text-foreground/90">
                              {oneLine(intent.description ?? intent.title)}
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                              <span className="truncate">{projectTitles[intent.project_id] ?? intent.project_id}</span>
                              <span className="shrink-0 text-muted-foreground/50">·</span>
                              <span className="shrink-0 font-mono">{intent.id.replace(/^intent:/, "")}</span>
                              <span className="shrink-0 text-muted-foreground/50">·</span>
                              <span className="shrink-0">
                                {intent.timestamp ? formatRelative(intent.timestamp) : "—"}
                              </span>
                            </div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>

          {/* ── Recent findings ── */}
          <Card className="gap-0 overflow-hidden p-0">
            <PanelHeader
              icon={SparklesIcon}
              title="Recent findings"
              meta={<span>{plural(totals.facts, "finding")}</span>}
            />
            <div className="px-4">
              {panelsLoading ? (
                <div className="divide-y">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={`finding-skeleton-${index.toString()}`} className="py-3">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="mt-2 h-3 w-1/2" />
                    </div>
                  ))}
                </div>
              ) : recentFindings.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground">
                  {hasData ? "No findings recorded for the latest projects." : "No findings yet."}
                </div>
              ) : (
                <div className="divide-y">
                  {recentFindings.map((finding: ProjectActivityItem) => (
                    <Link
                      key={`${finding.id}-${finding.cursor ?? ""}`}
                      prefetch={false}
                      href={`/projects/${finding.project_id}`}
                      className="-mx-2 flex items-start gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                    >
                      <Badge variant="outline" className="mt-0.5 shrink-0 px-1.5 py-0 font-mono text-[11px]">
                        {finding.id.replace(/^fact:/, "")}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-xs leading-snug text-foreground/90">
                          {oneLine(finding.description ?? finding.title)}
                        </div>
                        <div className="mt-1 truncate text-[11px] text-muted-foreground">
                          {projectTitles[finding.project_id] ?? finding.project_id} ·{" "}
                          {finding.timestamp ? formatRelative(finding.timestamp) : "—"}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
