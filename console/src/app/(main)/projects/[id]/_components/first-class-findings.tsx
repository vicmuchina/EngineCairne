"use client";

import * as React from "react";

import { ChevronDownIcon, FlaskConicalIcon, NetworkIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cairn, type Finding, type ProjectDetail } from "@/lib/cairn-api";
import { formatRelative } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

const SEVERITY_TONE: Record<string, string> = {
  critical: "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400",
  high: "border-orange-500/40 bg-orange-500/15 text-orange-600 dark:text-orange-400",
  medium: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  low: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
  info: "border-sky-500/40 bg-sky-500/15 text-sky-600 dark:text-sky-400",
};

const STATUS_TONE: Record<string, string> = {
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  in_progress: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  confirmed: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  resolved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  fixed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  false_positive: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
  ignored: "border-slate-500/30 bg-slate-500/10 text-slate-500",
  duplicate: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  risk_accepted: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

const FINDING_STATUSES = [
  "pending",
  "in_progress",
  "confirmed",
  "resolved",
  "fixed",
  "false_positive",
  "ignored",
  "duplicate",
  "risk_accepted",
];

function severityBadge(severity: string) {
  if (!severity) return <span className="text-[10px] text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide",
        SEVERITY_TONE[severity] ?? SEVERITY_TONE.low,
      )}
    >
      {severity}
    </span>
  );
}

function statusBadge(status: string) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0 text-[10px] font-medium whitespace-nowrap",
        STATUS_TONE[status] ?? STATUS_TONE.pending,
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function FirstClassFindings({
  projectId,
  detail,
  onOpenGraph,
  onOpenRetests,
  onRefresh,
}: {
  projectId: string;
  detail: ProjectDetail | null;
  onOpenGraph: (nodeId: string) => void;
  onOpenRetests: () => void;
  onRefresh: () => void;
}) {
  const findings = React.useMemo(() => detail?.findings ?? [], [detail]);
  const [query, setQuery] = React.useState("");
  const [severity, setSeverity] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return findings.filter((finding) => {
      if (severity !== "all" && finding.severity !== severity) return false;
      if (status !== "all" && finding.status !== status) return false;
      if (!needle) return true;
      return (
        finding.title.toLowerCase().includes(needle) ||
        finding.id.toLowerCase().includes(needle) ||
        finding.klass.toLowerCase().includes(needle) ||
        finding.summary.toLowerCase().includes(needle)
      );
    });
  }, [findings, query, severity, status]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function changeStatus(finding: Finding, next: string) {
    if (next === finding.status || busyId) return;
    setBusyId(finding.id);
    cairn
      .patchFinding(projectId, finding.id, { status: next })
      .then(() => {
        toast.success("Finding updated", { description: `${finding.id} → ${next.replace(/_/g, " ")}` });
        onRefresh();
      })
      .catch((cause: unknown) =>
        toast.error("Could not update the finding", {
          description: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .finally(() => setBusyId(null));
  }

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <span className="text-sm font-semibold">Findings</span>
        <Badge variant="outline" className="font-mono text-[10px]">
          {findings.length}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          · {findings.filter((finding) => finding.status === "confirmed").length} confirmed
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search findings…"
              className="h-8 w-48 pl-7 text-xs"
              aria-label="Search findings"
            />
          </div>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger size="sm" className="h-8 w-32 text-xs" aria-label="Filter by severity">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              {["critical", "high", "medium", "low", "info"].map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {FINDING_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8" onClick={onOpenRetests}>
            <FlaskConicalIcon data-icon="inline-start" />
            Retests
          </Button>
        </div>
      </div>

      <div className="divide-y">
        {visible.map((finding) => {
          const isOpen = expanded.has(finding.id);
          const retest = finding.retests?.[0];
          return (
            <div key={finding.id}>
              <button
                type="button"
                onClick={() => toggle(finding.id)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
              >
                <div className="mt-0.5 flex w-20 shrink-0 flex-col gap-1">
                  {severityBadge(finding.severity)}
                  {statusBadge(finding.status)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold leading-snug">{finding.title}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">#{finding.id}</span>
                    {finding.klass && (
                      <Badge variant="secondary" className="font-normal">
                        {finding.klass}
                      </Badge>
                    )}
                  </div>
                  {finding.summary && (
                    <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{finding.summary}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>
                      {finding.entity_ids.length} {finding.entity_ids.length === 1 ? "entity" : "entities"}
                    </span>
                    {finding.fact_id && <span>fact {finding.fact_id}</span>}
                    {retest && (
                      <span>
                        retest {retest.status}
                        {retest.verdict ? ` · ${retest.verdict}` : ""}
                      </span>
                    )}
                    <span>updated {formatRelative(finding.updated_at)}</span>
                  </div>
                </div>
                <ChevronDownIcon
                  className={cn(
                    "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
                    isOpen && "rotate-180",
                  )}
                />
              </button>
              {isOpen && (
                <div className="space-y-3 border-t bg-muted/20 px-4 py-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium text-muted-foreground">Disposition</span>
                    <Select
                      value={finding.status}
                      onValueChange={(value) => changeStatus(finding, value)}
                      disabled={busyId === finding.id}
                    >
                      <SelectTrigger size="sm" className="h-7 w-40 text-xs" aria-label="Change finding status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FINDING_STATUSES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {finding.fact_id && (
                      <Button
                        size="xs"
                        variant="outline"
                        className="h-7"
                        onClick={() => onOpenGraph(finding.fact_id as string)}
                      >
                        <NetworkIcon data-icon="inline-start" />
                        Open fact in graph
                      </Button>
                    )}
                    <Button size="xs" variant="outline" className="h-7" onClick={onOpenRetests}>
                      <FlaskConicalIcon data-icon="inline-start" />
                      Retests
                    </Button>
                  </div>
                  {finding.summary && <p className="whitespace-pre-wrap leading-relaxed">{finding.summary}</p>}
                  {finding.evidence && (
                    <details className="rounded border bg-background/60">
                      <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium text-muted-foreground">
                        Evidence
                      </summary>
                      <pre className="max-h-72 overflow-auto px-2 pb-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                        {finding.evidence}
                      </pre>
                    </details>
                  )}
                  {finding.report && (
                    <details className="rounded border bg-background/60">
                      <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium text-muted-foreground">
                        Full report
                      </summary>
                      <pre className="max-h-72 overflow-auto px-2 pb-2 whitespace-pre-wrap">{finding.report}</pre>
                    </details>
                  )}
                  {finding.entity_ids.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground">Entities</span>
                      {finding.entity_ids.map((entityId) => (
                        <Badge key={entityId} variant="outline" className="font-mono text-[10px]">
                          {entityId}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!visible.length && (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No findings match this search or filter.
          </p>
        )}
      </div>
    </Card>
  );
}
