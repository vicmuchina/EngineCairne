"use client";

import * as React from "react";

import {
  ActivityIcon,
  BotIcon,
  FileTextIcon,
  GaugeIcon,
  LightbulbIcon,
  ListChecksIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TargetIcon,
} from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectActivity } from "@/hooks/use-cairn";
import type { ProjectDetail } from "@/lib/cairn-api";
import { buildBroadcastEvents } from "@/lib/cairn-broadcast";
import { formatDate, formatNumber, formatRelative } from "@/lib/cairn-format";
import { type CairnSessionList, fetchSessions, sessionTokens } from "@/lib/cairn-sessions";
import { cn } from "@/lib/utils";

import { KindBadge, KindDot, kindLabel } from "./entity-kind";

const PREMISES = new Set(["origin", "goal"]);

const BROADCAST_LABELS: Record<string, string> = {
  goal: "Goal",
  intent: "Intent",
  fact: "Fact",
  finding: "Finding",
  hint: "Hint",
  tool: "Tool",
  entity: "Entity",
  retest: "Retest",
  status: "Status",
};

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return formatNumber(value);
}

function fmtSpan(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function SectionCard({
  icon: Icon,
  title,
  hint,
  children,
  className,
}: {
  icon: React.ElementType;
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden p-0", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-semibold">{title}</span>
        {hint && <span className="text-[11px] font-normal text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </Card>
  );
}

function StatCard({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2.5" title={title}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xl font-semibold tabular-nums tracking-tight">{value}</div>
    </div>
  );
}

function goalBadge(status: string | undefined) {
  if (status === "completed") {
    return {
      label: "Met",
      className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    };
  }
  if (status === "active") {
    return { label: "In progress", className: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400" };
  }
  if (status === "stopped") {
    return { label: "Paused", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" };
  }
  return { label: status ?? "—", className: "border-border bg-muted/50 text-muted-foreground" };
}

function modelRows(sessions: CairnSessionList | null) {
  const rows = new Map<
    string,
    { model: string; calls: number; callsKnown: boolean; input: number; output: number; cache: number }
  >();
  for (const session of sessions?.sessions ?? []) {
    const model = session.model?.trim();
    if (!model) continue;
    const tokens = sessionTokens(session);
    const messages = session.counts?.messages;
    const row = rows.get(model) ?? {
      model,
      calls: 0,
      callsKnown: false,
      input: 0,
      output: 0,
      cache: 0,
    };
    row.input += tokens.input;
    row.output += tokens.output;
    row.cache += tokens.cache_read;
    if (typeof messages === "number") {
      row.calls += messages;
      row.callsKnown = true;
    }
    rows.set(model, row);
  }
  return [...rows.values()].sort((a, b) => b.input + b.cache + b.output - (a.input + a.cache + a.output));
}

function hitRate(input: number, cache: number): string {
  const denominator = input + cache;
  if (denominator <= 0) return "—";
  return `${Math.round((cache / denominator) * 100)}%`;
}

/** Last 8 project_activity rows, formatted like the Broadcast board. */
function RecentActivity({ items }: { items: ReturnType<typeof useProjectActivity>["items"] }) {
  const rows = React.useMemo(() => {
    const latest = [...items]
      .sort((a, b) => {
        const at = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
        const bt = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
        return bt - at;
      })
      .slice(0, 8);
    return buildBroadcastEvents(latest, null);
  }, [items]);

  if (rows.length === 0)
    return <div className="px-4 py-6 text-center text-xs text-muted-foreground">No activity recorded yet.</div>;

  return (
    <div className="divide-y">
      {rows.map((event) => (
        <div key={event.key} className="flex items-start gap-3 px-4 py-2.5">
          <Badge variant="outline" className="mt-0.5 w-16 shrink-0 justify-center px-1.5 py-0 text-[10px] font-medium">
            {BROADCAST_LABELS[event.type] ?? "Status"}
          </Badge>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-xs leading-relaxed text-foreground/90">
              {event.description || event.title}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="font-mono">#{event.id}</span>
              <span>·</span>
              <span className="truncate">{event.author}</span>
              <span>·</span>
              <span suppressHydrationWarning>{event.timestamp ? formatRelative(event.timestamp) : "—"}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function OverviewTab({
  projectId,
  detail,
  loading,
  onOpenBroadcast,
}: {
  projectId: string;
  detail: ProjectDetail | null;
  loading?: boolean;
  onOpenBroadcast: () => void;
}) {
  const {
    items: feedItems,
    loading: feedLoading,
    error: feedError,
  } = useProjectActivity(projectId, {
    limit: 500,
    pollMs: 15000,
  });
  const [sessions, setSessions] = React.useState<CairnSessionList | null>(null);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await fetchSessions(projectId);
        if (alive) setSessions(next);
      } catch {
        // Keep the last successful snapshot; the rail/Conversations tab owns the
        // explicit sessions error state. Overview simply omits token rows.
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 15000);
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectId]);

  const project = detail?.project ?? null;
  const facts = React.useMemo(() => detail?.facts ?? [], [detail]);
  const intents = React.useMemo(() => detail?.intents ?? [], [detail]);
  const hints = React.useMemo(() => detail?.hints ?? [], [detail]);
  const entities = React.useMemo(() => detail?.entities ?? [], [detail]);
  const domainFindings = React.useMemo(() => detail?.findings ?? [], [detail]);
  const coverage = detail?.coverage ?? null;
  const origin = facts.find((fact) => fact.id === "origin");
  const goal = facts.find((fact) => fact.id === "goal");
  const findings = facts.filter((fact) => !PREMISES.has(fact.id)).length;
  const topKinds = React.useMemo(
    () => [...(coverage?.by_kind ?? [])].sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind)).slice(0, 3),
    [coverage],
  );
  const openIntents = intents.filter((intent) => !intent.concluded_at).length;
  const concludedIntents = intents.filter((intent) => intent.concluded_at).length;

  const workerSessions = (sessions?.sessions ?? []).filter((session) => session.role === "worker");
  const workerRuns = workerSessions.reduce((total, session) => total + Math.max(1, session.runs?.length ?? 0), 0);
  const toolCalls = (sessions?.sessions ?? []).reduce((total, session) => total + (session.counts?.tool_calls ?? 0), 0);

  const span = React.useMemo(() => {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const session of sessions?.sessions ?? []) {
      if (session.started_at) {
        const value = Date.parse(session.started_at);
        if (Number.isFinite(value) && value < start) start = value;
      }
      if (session.finished_at) {
        const value = Date.parse(session.finished_at);
        if (Number.isFinite(value) && value > end) end = value;
      }
    }
    if (!Number.isFinite(start) || end === 0 || end < start) return null;
    return end - start;
  }, [sessions]);

  const models = React.useMemo(() => modelRows(sessions), [sessions]);
  const taskTotal = sessions?.task_total;
  const totalCalls = models.reduce((total, row) => total + row.calls, 0);
  const totalTokenSum = models.reduce((total, row) => total + row.input + row.cache + row.output, 0);
  const latestActivity = React.useMemo(() => {
    let latest: string | null = null;
    let latestTs = 0;
    for (const item of feedItems) {
      const value = item.timestamp ? Date.parse(item.timestamp) : 0;
      if (Number.isFinite(value) && value >= latestTs) {
        latestTs = value;
        latest = item.timestamp;
      }
    }
    for (const session of sessions?.sessions ?? []) {
      const value = session.last_activity_at ? Date.parse(session.last_activity_at) : 0;
      if (Number.isFinite(value) && value > latestTs) {
        latestTs = value;
        latest = session.last_activity_at ?? null;
      }
    }
    return latest;
  }, [feedItems, sessions]);

  if (!project) {
    return (
      <Card className="p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-4 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-3/4" />
        <Skeleton className="mt-6 h-16 w-full" />
      </Card>
    );
  }

  const badge = goalBadge(project.status);
  const hasTaskCopy = Boolean(origin?.description || goal?.description);

  return (
    <div className="flex flex-col gap-4">
      {hasTaskCopy && (
        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FileTextIcon className="size-4 text-muted-foreground" />
              Task description and goal
            </div>
            <span className="text-[11px] text-muted-foreground">
              {project.id} · {formatDate(project.created_at)}
            </span>
          </div>
          <div className="grid grid-cols-1 divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <div className="min-w-0 p-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Description
              </div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
                {origin?.description ?? "—"}
              </p>
            </div>
            <div className="min-w-0 p-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Goal</div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
                {goal?.description ?? "—"}
              </p>
            </div>
          </div>
        </Card>
      )}

      {goal?.description && (
        <SectionCard icon={TargetIcon} title="Goal status" hint="Derived from the project status">
          <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
            <p className="line-clamp-2 min-w-0 text-xs leading-relaxed text-foreground/90" title={goal.description}>
              {goal.description}
            </p>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border px-2 py-0.5 text-[11px] font-medium",
                badge.className,
              )}
            >
              <span className="size-1.5 rounded-full bg-current opacity-70" />
              {badge.label}
            </span>
          </div>
        </SectionCard>
      )}

      {coverage && coverage.denominator > 0 && (
        <SectionCard
          icon={GaugeIcon}
          title="Scope & coverage"
          hint={`${coverage.tested}/${coverage.denominator} in-scope assets tested`}
        >
          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Coverage</div>
                <div className="text-2xl font-semibold tabular-nums tracking-tight">
                  {coverage.pct === null ? "—" : `${Math.round(coverage.pct * 100)}%`}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Tested</div>
                <div className="text-sm font-medium tabular-nums">
                  {formatNumber(coverage.tested)}/{formatNumber(coverage.denominator)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Scope rows</div>
                <div className="text-sm font-medium tabular-nums">{formatNumber(coverage.scope_rows)}</div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {topKinds.map((row) => (
                  <KindBadge key={row.kind} kind={row.kind} count={row.total} />
                ))}
              </div>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full border bg-muted/30">
              <div
                className="h-full rounded-full bg-emerald-500/80"
                style={{ width: `${Math.max(0, Math.min(100, (coverage.pct ?? 0) * 100))}%` }}
              />
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Untested sample</div>
              {coverage.untested.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {coverage.untested.slice(0, 6).map((row) => (
                    <span
                      key={row.id}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/20 px-1.5 py-0.5 text-[11px]"
                      title={row.key}
                    >
                      <KindDot kind={row.kind} />
                      <span className="truncate">{row.label || row.key}</span>
                      <span className="text-muted-foreground">{kindLabel(row.kind)}</span>
                    </span>
                  ))}
                  {coverage.untested.length > 6 && (
                    <span className="text-[11px] text-muted-foreground">+{coverage.untested.length - 6} more</span>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">Every in-scope asset is tested.</p>
              )}
            </div>
          </div>
        </SectionCard>
      )}

      {hints.length > 0 && (
        <SectionCard
          icon={LightbulbIcon}
          title="Operator constraints"
          hint={`${formatNumber(hints.length)} hint${hints.length === 1 ? "" : "s"}`}
        >
          <div className="max-h-72 overflow-y-auto">
            <div className="grid grid-cols-1 divide-y xl:grid-cols-2 xl:divide-x xl:divide-y-0">
              {hints.map((hint) => (
                <div key={hint.id} className="flex items-start gap-3 px-4 py-2.5 xl:[&:nth-child(odd)]:border-r-0">
                  <Badge variant="outline" className="mt-0.5 shrink-0 px-1.5 py-0 font-mono text-[10px]">
                    {hint.creator}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">{hint.content}</p>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {hint.id} · {formatRelative(hint.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      )}

      <SectionCard icon={ListChecksIcon} title="Results at a glance">
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9">
          <StatCard label="Facts" value={formatNumber(facts.length)} />
          {domainFindings.length === 0 && (
            <StatCard label="Findings (facts)" value={formatNumber(findings)} title="Non-premise facts" />
          )}
          <StatCard label="Entities" value={formatNumber(entities.length)} title="Generalized domain assets" />
          <StatCard label="Findings" value={formatNumber(domainFindings.length)} title="Recorded domain findings" />
          <StatCard label="Open intents" value={formatNumber(openIntents)} />
          <StatCard label="Concluded intents" value={formatNumber(concludedIntents)} />
          <StatCard label="Worker runs" value={sessions ? formatNumber(workerRuns) : "—"} />
          <StatCard label="Tool calls" value={sessions ? formatNumber(toolCalls) : "—"} />
          <StatCard label="Wall-clock span" value={sessions ? fmtSpan(span) : "—"} />
        </div>
      </SectionCard>

      {models.length > 0 && taskTotal && (
        <SectionCard
          icon={BotIcon}
          title="LLM token usage"
          hint={`by model, ${formatNumber(totalCalls)} calls in total`}
        >
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-4 py-2.5 text-xs text-muted-foreground">
            <span>
              Input <span className="font-mono text-foreground">{fmtTokens(taskTotal.input)}</span>
            </span>
            <span>
              Output <span className="font-mono text-foreground">{fmtTokens(taskTotal.output)}</span>
            </span>
            <span>
              Cache reads <span className="font-mono text-foreground">{fmtTokens(taskTotal.cache_read)}</span>
            </span>
            <span>
              Cache hit rate{" "}
              <span className="font-mono text-emerald-600 dark:text-emerald-400">
                {hitRate(taskTotal.input, taskTotal.cache_read)}
              </span>
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b text-left text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 text-right font-medium">Calls</th>
                  <th className="px-3 py-2 text-right font-medium">Input</th>
                  <th className="px-3 py-2 text-right font-medium">Output</th>
                  <th className="px-3 py-2 text-right font-medium">Cache read</th>
                  <th className="px-4 py-2 text-right font-medium">Hit rate</th>
                </tr>
              </thead>
              <tbody>
                {models.map((row) => (
                  <tr key={row.model} className="border-b last:border-0">
                    <td className="max-w-56 truncate px-4 py-2 font-mono text-[11px]" title={row.model}>
                      {row.model}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {row.callsKnown ? formatNumber(row.calls) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums" title={formatNumber(row.input)}>
                      {fmtTokens(row.input)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums" title={formatNumber(row.output)}>
                      {fmtTokens(row.output)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums" title={formatNumber(row.cache)}>
                      {fmtTokens(row.cache)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{hitRate(row.input, row.cache)}</td>
                  </tr>
                ))}
                <tr className="bg-muted/20 font-medium">
                  <td className="px-4 py-2">Task total</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{formatNumber(totalCalls)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums" title={formatNumber(taskTotal.input)}>
                    {fmtTokens(taskTotal.input)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums" title={formatNumber(taskTotal.output)}>
                    {fmtTokens(taskTotal.output)}
                  </td>
                  <td
                    className="px-3 py-2 text-right font-mono tabular-nums"
                    title={formatNumber(taskTotal.cache_read)}
                  >
                    {fmtTokens(taskTotal.cache_read)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">
                    {hitRate(taskTotal.input, taskTotal.cache_read)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {totalTokenSum === 0 && (
            <div className="px-4 py-2 text-[11px] text-muted-foreground">No token usage recorded.</div>
          )}
        </SectionCard>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SectionCard icon={ActivityIcon} title="Recent activity" hint="last 8 project events">
            <div className="flex justify-end px-4 pt-2">
              <Button size="sm" variant="outline" onClick={onOpenBroadcast}>
                Broadcast board
              </Button>
            </div>
            {feedLoading && feedItems.length === 0 ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : feedError ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">{feedError}</div>
            ) : (
              <RecentActivity items={feedItems} />
            )}
          </SectionCard>
        </div>

        <SectionCard icon={ShieldCheckIcon} title="Runtime">
          <div className="flex flex-col gap-2 p-4 text-[11px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Created</span>
              <span>{formatDate(project.created_at)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Last activity</span>
              <span suppressHydrationWarning>{latestActivity ? formatRelative(latestActivity) : "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Project id</span>
              <span className="font-mono">{project.id}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Status</span>
              <StatusBadge domain="project" value={project.status} dot className="px-1.5 py-0 text-[10px]" />
            </div>
            {sessions?.generated_at && (
              <div className="flex items-center justify-between gap-3 border-t pt-2">
                <span className="text-muted-foreground">Sessions snapshot</span>
                <span suppressHydrationWarning>{formatRelative(sessions.generated_at)}</span>
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {loading && !detail && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCwIcon className="size-3.5 animate-spin" />
          Loading the project overview…
        </div>
      )}
    </div>
  );
}
