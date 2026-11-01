"use client";

import * as React from "react";

import {
  AlertTriangleIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  Loader2Icon,
  PlayIcon,
  RotateCwIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cairn, type Finding, type ProjectDetail, type Retest } from "@/lib/cairn-api";
import { formatRelative } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

const SEVERITY_TONE: Record<string, string> = {
  critical: "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400",
  high: "border-orange-500/40 bg-orange-500/15 text-orange-600 dark:text-orange-400",
  medium: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  low: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
  info: "border-sky-500/40 bg-sky-500/15 text-sky-600 dark:text-sky-400",
};

const FINDING_STATUS_TONE: Record<string, string> = {
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

const RETEST_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "Waiting to start", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  running: { label: "Retesting", className: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  completed: { label: "Done", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Failed", className: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  stopped: { label: "Stopped", className: "border-slate-500/30 bg-slate-500/10 text-slate-500" },
};

const VERDICT: Record<string, { label: string; className: string }> = {
  reproduced: { label: "Still reproducible", className: "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400" },
  fixed: { label: "Fixed", className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  inconclusive: { label: "Cannot confirm", className: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400" },
};

function severityBadge(severity: string) {
  if (!severity) return null;
  return (
    <span className={cn("rounded border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide", SEVERITY_TONE[severity] ?? SEVERITY_TONE.low)}>
      {severity}
    </span>
  );
}

function findingStatusBadge(status: string) {
  return (
    <span className={cn("rounded border px-1.5 py-0 text-[10px] font-medium whitespace-nowrap", FINDING_STATUS_TONE[status] ?? FINDING_STATUS_TONE.pending)}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function retestStatusBadge(status: string) {
  const meta = RETEST_STATUS[status] ?? RETEST_STATUS.pending;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-medium whitespace-nowrap", meta.className)}>
      {status === "running" && <Loader2Icon className="size-2.5 animate-spin" />}
      {meta.label}
    </span>
  );
}

function verdictBadge(verdict: string) {
  if (!verdict) return null;
  const meta = VERDICT[verdict] ?? VERDICT.inconclusive;
  return (
    <span className={cn("rounded border px-1.5 py-0 text-[10px] font-semibold whitespace-nowrap", meta.className)}>
      {meta.label}
    </span>
  );
}

function RetestRow({ retest }: { retest: Retest }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-lg border bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {retestStatusBadge(retest.status)}
        {verdictBadge(retest.verdict)}
        <span className="font-mono text-[11px] text-muted-foreground">#{retest.id}</span>
        <span className="text-[11px] text-muted-foreground">
          {retest.created_at ? formatRelative(retest.created_at) : "—"}
        </span>
        <ChevronDownIcon className={cn("ml-auto size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2 text-xs">
          {retest.summary && <p className="whitespace-pre-wrap leading-relaxed">{retest.summary}</p>}
          {retest.error && (
            <p className="flex items-start gap-1.5 text-rose-600 dark:text-rose-400">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              {retest.error}
            </p>
          )}
          {retest.notes && <p className="text-muted-foreground">Notes: {retest.notes}</p>}
          {retest.evidence && (
            <details className="rounded border bg-muted/30">
              <summary className="cursor-pointer px-2 py-1 text-[11px] font-medium text-muted-foreground">
                Evidence
              </summary>
              <pre className="max-h-64 overflow-auto px-2 pb-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                {retest.evidence}
              </pre>
            </details>
          )}
          {retest.run_id && (
            <p className="font-mono text-[10px] text-muted-foreground">run {retest.run_id}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function RetestsTab({
  projectId,
  detail,
  loading,
  onRefresh,
  onOpenFindings,
}: {
  projectId: string;
  detail: ProjectDetail | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenFindings: () => void;
}) {
  const findings = React.useMemo(() => detail?.findings ?? [], [detail]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!selectedId && findings.length) setSelectedId(findings[0].id);
  }, [findings, selectedId]);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return findings;
    return findings.filter(
      (finding) =>
        finding.title.toLowerCase().includes(needle) ||
        finding.id.toLowerCase().includes(needle) ||
        finding.klass.toLowerCase().includes(needle),
    );
  }, [findings, query]);

  const selected = findings.find((finding) => finding.id === selectedId) ?? null;
  const retests = (detail?.retests ?? []).filter((retest) => retest.finding_id === selectedId);
  const active = retests.find((retest) => retest.status === "pending" || retest.status === "running");
  const hasActive = Boolean(active);
  // A completed project has no dispatcher, so a queued retest would wait forever.
  const projectCompleted = detail?.project.status === "completed";

  function createRetest() {
    if (!selected || busy || projectCompleted) return;
    setBusy(true);
    cairn
      .createRetest(projectId, selected.id, { notes: notes.trim() })
      .then(() => {
        setDialogOpen(false);
        setNotes("");
        toast.success("Retest queued", { description: `Finding ${selected.id}` });
        onRefresh();
      })
      .catch((cause: unknown) =>
        toast.error("Could not queue the retest", {
          description: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .finally(() => setBusy(false));
  }

  if (loading && !detail) {
    return <Card className="p-6 text-sm text-muted-foreground">Loading findings…</Card>;
  }

  if (!findings.length) {
    return (
      <Card className="flex flex-col items-center gap-2 p-10 text-center">
        <FlaskConicalIcon className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No findings available to retest</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Retests re-run the original test for a confirmed finding. Record a finding first
          (agents write them through the write-back API).
        </p>
        <Button size="sm" variant="outline" onClick={onOpenFindings}>
          Open findings
        </Button>
      </Card>
    );
  }

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Card className="flex min-h-0 flex-col gap-0 overflow-hidden p-0">
        <div className="border-b px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Pick a finding</span>
            <span className="text-[11px] text-muted-foreground">{findings.length}</span>
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search findings…"
            className="mt-2 h-8 text-xs"
            aria-label="Search findings to retest"
          />
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-1.5">
            {visible.map((finding) => {
              const isActive = finding.id === selectedId;
              const findingRetests = (detail?.retests ?? []).filter((r) => r.finding_id === finding.id);
              const running = findingRetests.some((r) => r.status === "pending" || r.status === "running");
              return (
                <button
                  key={finding.id}
                  type="button"
                  onClick={() => setSelectedId(finding.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors",
                    isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                  )}
                >
                  <span className="line-clamp-1 text-[13px] font-medium">{finding.title}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {severityBadge(finding.severity)}
                    {findingStatusBadge(finding.status)}
                    {running && <Loader2Icon className="size-3 animate-spin text-blue-500" />}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">#{finding.id}</span>
                  </span>
                </button>
              );
            })}
            {!visible.length && (
              <p className="px-2 py-4 text-xs text-muted-foreground">No findings match this search.</p>
            )}
          </div>
        </ScrollArea>
      </Card>

      <Card className="flex min-h-0 flex-col gap-0 overflow-hidden p-0">
        {selected ? (
          <>
            <div className="border-b px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {severityBadge(selected.severity)}
                {findingStatusBadge(selected.status)}
                <span className="font-mono text-[11px] text-muted-foreground">#{selected.id}</span>
                {selected.klass && (
                  <Badge variant="outline" className="max-w-full font-normal">
                    <span className="min-w-0 truncate">{selected.klass}</span>
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => setDialogOpen(true)}
                  disabled={hasActive || busy || projectCompleted}
                  title={
                    projectCompleted
                      ? "This project is completed; resume it to run a retest"
                      : hasActive
                        ? "A retest is already running for this finding"
                        : "Queue a retest"
                  }
                >
                  {hasActive ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <PlayIcon data-icon="inline-start" />}
                  {projectCompleted
                    ? "Project completed"
                    : active?.status === "running"
                      ? "Retest running"
                      : active
                        ? "Retest queued"
                        : "Start a retest"}
                </Button>
              </div>
              <h3 className="mt-2 text-base font-semibold leading-tight">{selected.title}</h3>
              {selected.summary && (
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{selected.summary}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>
                  {selected.entity_ids.length} linked {selected.entity_ids.length === 1 ? "entity" : "entities"}
                </span>
                {selected.fact_id && <span>fact {selected.fact_id}</span>}
                <span>updated {formatRelative(selected.updated_at)}</span>
                <Button size="xs" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={onOpenFindings}>
                  Open findings
                </Button>
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-2 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <RotateCwIcon className="size-3.5 text-muted-foreground" />
                  Retest history
                  <span className="font-normal text-muted-foreground">({retests.length})</span>
                </div>
                {retests.length ? (
                  retests.map((retest) => <RetestRow key={retest.id} retest={retest} />)
                ) : (
                  <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                    No retest record yet.
                  </p>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            Select a finding to see its retests.
          </div>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a retest</DialogTitle>
            <DialogDescription>
              Re-runs the original test for <span className="font-mono">#{selected?.id}</span> and
              records a verdict (reproduced / fixed / inconclusive). A worker executes it like any
              other intent.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value.slice(0, 4000))}
            placeholder="Optional notes for the retester (what changed, what to compare)…"
            className="min-h-24"
          />
          <DialogFooter showCloseButton>
            <Button onClick={createRetest} disabled={busy}>
              {busy ? <Loader2Icon className="animate-spin" /> : <FlaskConicalIcon />}
              Queue retest
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
