"use client";

import * as React from "react";

import {
  AlertTriangleIcon,
  BrainIcon,
  ChevronDownIcon,
  ClockIcon,
  Loader2Icon,
  MessageSquareIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cairn, type ProjectActivityItem, type WorkerRunItem, type WorkerRunList } from "@/lib/cairn-api";
import { formatNumber, formatRelative, oneLine } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

const POLL_MS = 1000;

type WorkerStep = {
  item: ProjectActivityItem;
  result?: ProjectActivityItem;
};

function metaText(item: ProjectActivityItem, key: string): string | null {
  const value = item.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metaBool(item: ProjectActivityItem, key: string): boolean {
  return item.metadata[key] === true;
}

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Pair tool calls/results by metadata.tool_call_id without re-sorting the snapshot. */
function pairTranscript(items: readonly ProjectActivityItem[]): WorkerStep[] {
  const resultByCall = new Map<string, ProjectActivityItem>();
  const callIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "tool_call") {
      const callId = metaText(item, "tool_call_id");
      if (callId) callIds.add(callId);
    }
    if (item.kind !== "tool_result") continue;
    const callId = metaText(item, "tool_call_id");
    if (callId) resultByCall.set(callId, item);
  }
  const usedResults = new Set<string>();
  const steps: WorkerStep[] = [];
  for (const item of items) {
    if (item.kind === "tool_call") {
      const callId = metaText(item, "tool_call_id");
      const result = callId ? resultByCall.get(callId) : undefined;
      if (result) usedResults.add(result.id);
      steps.push({ item, result });
      continue;
    }
    if (item.kind === "tool_result") {
      const callId = metaText(item, "tool_call_id");
      if (usedResults.has(item.id) || (callId && callIds.has(callId))) continue;
    }
    steps.push({ item });
  }
  return steps;
}

function ThinkingRow({ item }: { item: ProjectActivityItem }) {
  const live = item.status === "streaming" || item.status === "running";
  const [open, setOpen] = React.useState(live);
  React.useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="rounded-lg border bg-muted/10"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
        <BrainIcon className="size-3.5" />
        Thinking
        <StatusBadge domain="worker" value={item.status ?? "unknown"} dot className="px-1.5 py-0 text-[10px]" />
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{formatRelative(item.timestamp)}</span>
        <ChevronDownIcon className="size-3.5 transition-transform [[open]>&]:rotate-180" />
      </summary>
      <pre className="max-h-56 overflow-auto border-t px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {item.description?.trim() || (live ? "Thinking…" : "No reasoning text recorded.")}
      </pre>
    </details>
  );
}

function WorkerToolCard({ step }: { step: WorkerStep }) {
  const { item, result } = step;
  const name = metaText(item, "tool_name") ?? metaText(result ?? item, "tool_name") ?? "tool";
  const callId = metaText(item, "tool_call_id");
  const input = metaText(item, "tool_input") ?? item.description;
  const output =
    (result ? (metaText(result, "tool_output") ?? result.description) : null) ?? metaText(item, "tool_output");
  const status = result?.status ?? item.status;
  const failed = status === "error" || (result ? metaBool(result, "is_error") : false);
  const running = (status === "running" || status === "streaming") && !output;
  const error = result ? (metaText(result, "error") ?? (failed ? result.description : null)) : null;
  return (
    <div className={cn("rounded-lg border bg-muted/20", failed && "border-destructive/30")}>
      <div className="flex flex-wrap items-center gap-2 border-b px-2.5 py-1.5">
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-[11px] font-medium">{name}</span>
        <StatusBadge domain="worker" value={status ?? "unknown"} dot className="px-1.5 py-0 text-[10px]" />
        {callId && <span className="font-mono text-[10px] text-muted-foreground/60">{callId}</span>}
        <span className="ml-auto text-[10px] text-muted-foreground/60">{formatRelative(item.timestamp)}</span>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        {input && (
          <div>
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Input</div>
            <pre className="max-h-44 overflow-auto rounded border bg-background/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
              {pretty(input)}
            </pre>
          </div>
        )}
        {output ? (
          <div>
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Output</div>
            <pre
              className={cn(
                "max-h-44 overflow-auto rounded border bg-background/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words",
                failed && "border-destructive/30 text-destructive",
              )}
            >
              {output.length > 5000 ? `${output.slice(0, 5000)}…` : output}
            </pre>
          </div>
        ) : running ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> Running…
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">No output recorded.</div>
        )}
        {error && <div className="text-[11px] text-destructive">{error}</div>}
      </div>
    </div>
  );
}

function WorkerResultRow({ item }: { item: ProjectActivityItem }) {
  const output = metaText(item, "tool_output") ?? item.description ?? "";
  const failed = metaBool(item, "is_error") || item.status === "error";
  const error = metaText(item, "error") ?? (failed ? item.description : null);
  return (
    <div className={cn("rounded-lg border bg-muted/20", failed && "border-destructive/30")}>
      <div className="flex flex-wrap items-center gap-2 border-b px-2.5 py-1.5">
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-[11px] font-medium">{item.title}</span>
        <StatusBadge domain="worker" value={item.status ?? "unknown"} dot className="px-1.5 py-0 text-[10px]" />
        <span className="ml-auto text-[10px] text-muted-foreground/60">{formatRelative(item.timestamp)}</span>
      </div>
      <div className="p-2.5">
        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Output</div>
        <pre
          className={cn(
            "max-h-44 overflow-auto rounded border bg-background/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words",
            failed && "border-destructive/30 text-destructive",
          )}
        >
          {output.length > 5000 ? `${output.slice(0, 5000)}…` : output || "No output recorded."}
        </pre>
        {error && <div className="mt-1 text-[11px] text-destructive">{error}</div>}
      </div>
    </div>
  );
}

function WorkerStepRow({ step }: { step: WorkerStep }) {
  const { item, result } = step;
  if (!result && item.kind === "worker_thinking") return <ThinkingRow item={item} />;
  if (!result && item.kind === "tool_result") return <WorkerResultRow item={item} />;
  if (item.kind === "tool_call") {
    return <WorkerToolCard step={{ item, result }} />;
  }
  if (item.kind === "worker_error") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
        <div className="mb-0.5 flex items-center gap-1.5 font-medium">
          <AlertTriangleIcon className="size-3.5" />
          Worker error
          <span className="ml-auto font-mono text-[10px] text-destructive/70">{formatRelative(item.timestamp)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words">{item.description ?? "No error text recorded."}</div>
      </div>
    );
  }
  if (item.kind === "worker_message") {
    const live = item.status === "streaming" || item.status === "running";
    return (
      <div className="rounded-lg border bg-muted/20">
        <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
          <MessageSquareIcon className="size-3.5" />
          Worker message
          <StatusBadge
            domain="worker"
            value={item.status ?? "unknown"}
            dot
            className="ml-auto px-1.5 py-0 text-[10px]"
          />
          {live && <Loader2Icon className="size-3 animate-spin" />}
        </div>
        <pre className="max-h-60 overflow-auto px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {item.description?.trim() || (live ? "Streaming…" : "No message text recorded.")}
        </pre>
      </div>
    );
  }
  if (item.kind === "worker_output") {
    return (
      <div className="rounded-lg border bg-muted/10">
        <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
          <TerminalIcon className="size-3.5" />
          Raw stdout
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
            {formatRelative(item.timestamp)}
          </span>
        </div>
        <pre className="max-h-40 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {item.description ?? ""}
        </pre>
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-muted/10 px-2.5 py-2 text-[11px] text-muted-foreground">
      <div className="font-medium text-foreground/80">{item.title}</div>
      {item.description && <div className="mt-0.5 whitespace-pre-wrap break-words">{item.description}</div>}
    </div>
  );
}

function WorkerRunCard({ run }: { run: WorkerRunItem }) {
  const status = run.stale ? "stale" : run.status;
  const steps = React.useMemo(() => pairTranscript(run.transcript), [run.transcript]);
  const duration = formatDuration(run.duration_ms);
  const counts = run.counts;
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{run.worker}</span>
            <StatusBadge domain="worker" value={status ?? "unknown"} dot className="px-1.5 py-0 text-[10px]" />
            {run.active && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                Live
              </Badge>
            )}
            {run.active && <Loader2Icon className="size-3.5 animate-spin text-blue-500" />}
            {run.intent_id && <span className="font-mono text-[11px] text-muted-foreground">{run.intent_id}</span>}
            {run.task && (
              <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                {run.task}
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/90">
            {run.intent_description ? oneLine(run.intent_description) : "No intent description recorded."}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="size-3" />
              {run.started_at ? formatRelative(run.started_at) : "unknown start"}
            </span>
            {run.finished_at && <span>finished {formatRelative(run.finished_at)}</span>}
            {duration && <span>{duration}</span>}
            <span className="font-mono text-[10px] text-muted-foreground/60">{run.run_id.slice(0, 12)}</span>
            {run.session && <span className="font-mono text-[10px]">session {run.session}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="rounded border bg-muted/30 px-1.5 py-0.5">{formatNumber(counts.activities)} steps</span>
          <span className="rounded border bg-muted/30 px-1.5 py-0.5">{formatNumber(counts.thinking)} thinking</span>
          <span className="rounded border bg-muted/30 px-1.5 py-0.5">
            {formatNumber(counts.tool_calls)} call · {formatNumber(counts.tool_results)} result
          </span>
          <span className="rounded border bg-muted/30 px-1.5 py-0.5">{formatNumber(counts.messages)} message</span>
          {counts.errors > 0 && (
            <span className="rounded border border-destructive/30 bg-destructive/5 px-1.5 py-0.5 text-destructive">
              {formatNumber(counts.errors)} error
            </span>
          )}
        </div>
      </div>

      {run.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
          {run.error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {steps.length === 0 ? (
          <div className="rounded-lg border border-dashed px-3 py-4 text-center text-[11px] text-muted-foreground">
            {run.active ? "Waiting for the first transcript step…" : "No transcript steps were recorded for this run."}
          </div>
        ) : (
          steps.map((step) => <WorkerStepRow key={`${step.item.id}-${step.result?.id ?? "call"}`} step={step} />)
        )}
        {run.transcript_truncated && (
          <div className="text-[10px] text-muted-foreground">
            Showing the newest transcript steps; the run summary counts the full run.
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkersTab({ projectId }: { projectId: string }) {
  const [data, setData] = React.useState<WorkerRunList | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const aliveRef = React.useRef(true);

  const load = React.useCallback(
    async (manual = false) => {
      if (manual) setRefreshing(true);
      try {
        const next = await cairn.listProjectWorkers(projectId, {
          limit: 20,
          transcriptLimit: 200,
          includeTranscript: true,
        });
        if (!aliveRef.current) return;
        setData(next);
        setError(null);
      } catch (cause) {
        if (!aliveRef.current) return;
        setError((cause as Error).message);
      } finally {
        if (aliveRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [projectId],
  );

  React.useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    setData(null);
    setError(null);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const activeCount = data?.active_count ?? 0;
  const runs = data?.items ?? [];

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <RadioTowerIcon className="size-4 text-muted-foreground" />
          Workers
          <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
            {formatNumber(activeCount)} active
          </Badge>
          <span className="text-[11px] font-normal text-muted-foreground">
            {runs.length > 0 ? `${formatNumber(runs.length)} recent runs` : "live worker API"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                activeCount > 0 ? "animate-pulse bg-blue-500" : "bg-muted-foreground/40",
              )}
            />
            polled 1s
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => void load(true)}
            disabled={refreshing}
            aria-label="Refresh workers"
          >
            <RefreshCwIcon className={cn(refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-[11px] text-destructive">
          Workers API: {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <RadioTowerIcon className="size-5 text-muted-foreground" />
          </div>
          <div className="text-sm font-medium">No running workers</div>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            The worker API is live, but the dispatcher is frozen (B44), so no run has been recorded. This view shows
            real dispatcher runs and their pi transcripts when an intent is claimed; it never invents rows.
          </p>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
            GET /projects/{projectId}/workers · polled every 1s
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {runs.map((run) => (
            <WorkerRunCard key={run.run_id} run={run} />
          ))}
        </div>
      )}
    </Card>
  );
}
