"use client";

import * as React from "react";

import Link from "next/link";

import {
  CheckIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  FileTextIcon,
  GitBranchIcon,
  Loader2Icon,
  PrinterIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";

import { Markdown } from "@/components/markdown";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cairn, type Intent, type ProjectDetail, type ProjectReport } from "@/lib/cairn-api";
import { formatDate, formatNumber, formatRelative, idOrdinal, oneLine } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

const PREMISES = new Set(["origin", "goal"]);
type ExportFormat = "yaml" | "timeline";

function reportTotalIntents(report: ProjectReport | null): number | null {
  const counts = report?.counts;
  if (!counts) return null;
  const completed = typeof counts.completed_intents === "number" ? counts.completed_intents : null;
  const open = typeof counts.open_intents === "number" ? counts.open_intents : null;
  if (completed === null && open === null) return null;
  return (completed ?? 0) + (open ?? 0);
}

function ReportMarkdownCard({ projectId }: { projectId: string }) {
  const [report, setReport] = React.useState<ProjectReport | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const alive = React.useRef(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await cairn.getProjectReport(projectId);
      if (!alive.current) return;
      if (!next || typeof next.markdown !== "string" || !next.markdown.trim()) {
        throw new Error("The report endpoint returned no Markdown.");
      }
      setReport(next);
    } catch (cause) {
      if (!alive.current) return;
      setReport(null);
      setError((cause as Error).message || "The report endpoint is unavailable.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    alive.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 15000);
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const markdown = report?.markdown ?? "";
  const generated = report?.generated_at ? new Date(report.generated_at) : null;
  const generatedLabel =
    generated && !Number.isNaN(generated.getTime()) ? generated.toLocaleString() : "—";
  const facts = typeof report?.counts?.facts === "number" ? report.counts.facts : null;
  const intents = reportTotalIntents(report);

  async function copy() {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      setActionError(null);
    } catch {
      setActionError("Clipboard unavailable in this browser context.");
    }
  }

  function download() {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${projectId}-report.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FileTextIcon className="size-4 text-muted-foreground" />
          Report (Markdown)
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void copy()} disabled={!markdown || loading}>
            {copied ? <CheckIcon data-icon="inline-start" /> : <ClipboardCopyIcon data-icon="inline-start" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" variant="outline" onClick={download} disabled={!markdown || loading}>
            <DownloadIcon data-icon="inline-start" />
            Download .md
          </Button>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCwIcon data-icon="inline-start" className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
        <span>Generated {generatedLabel}</span>
        <span>·</span>
        <span>{facts === null ? "—" : formatNumber(facts)} facts</span>
        <span>·</span>
        <span>{intents === null ? "—" : formatNumber(intents)} intents</span>
      </div>
      {actionError && <div className="border-b px-4 py-2 text-[11px] text-destructive">{actionError}</div>}
      {loading && !markdown ? (
        <div className="p-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-5/6" />
          <Skeleton className="mt-2 h-4 w-2/3" />
        </div>
      ) : error ? (
        <div className="p-4">
          <Alert variant="destructive">
            <FileTextIcon />
            <AlertTitle>Report unavailable</AlertTitle>
            <AlertDescription>
              <span className="break-all font-mono text-[11px]">{error}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                This build reads GET /api/projects/{projectId}/report. No fallback report is generated in the UI.
              </span>
            </AlertDescription>
            <Button size="sm" variant="outline" className="mt-2 w-fit" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
              Retry
            </Button>
          </Alert>
        </div>
      ) : (
        <div className="max-h-[70vh] min-h-40 overflow-y-auto px-5 py-4">
          <Markdown text={markdown} />
        </div>
      )}
    </Card>
  );
}

function CountTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{formatNumber(value)}</div>
    </div>
  );
}

function ProducerLink({
  producer,
  onOpenGraph,
}: {
  producer?: Intent;
  onOpenGraph?: (nodeId: string) => void;
}) {
  if (!producer) return <span className="text-[11px] text-muted-foreground">bootstrap</span>;
  const label = producer.worker ?? producer.creator;
  if (!onOpenGraph) {
    return (
      <span className="text-[11px] text-muted-foreground">
        {label} · {producer.id}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenGraph(producer.id)}
      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {label} · {producer.id}
    </button>
  );
}

export function ReportTab({
  detail,
  loading,
  onOpenGraph,
}: {
  detail: ProjectDetail | null;
  loading: boolean;
  onOpenGraph?: (nodeId: string) => void;
}) {
  const project = detail?.project ?? null;
  const facts = detail?.facts ?? [];
  const intents = detail?.intents ?? [];
  const findings = facts.filter((fact) => !PREMISES.has(fact.id));
  const origin = facts.find((fact) => fact.id === "origin");
  const goal = facts.find((fact) => fact.id === "goal");
  const working = intents.filter((intent) => !intent.concluded_at && intent.worker).length;
  const unclaimed = intents.filter((intent) => !intent.concluded_at && !intent.worker).length;
  const concluded = intents.filter((intent) => intent.concluded_at).length;
  const producers = new Map<string, Intent>();
  for (const intent of intents) if (intent.to) producers.set(intent.to, intent);
  const workers = [...new Set(intents.map((intent) => intent.worker).filter(Boolean))] as string[];

  const topFindings = [...findings]
    .sort((a, b) => idOrdinal(b.id) - idOrdinal(a.id))
    .slice(0, 6);
  const recentIntents = [...intents]
    .sort((a, b) => Date.parse(b.concluded_at ?? b.created_at) - Date.parse(a.concluded_at ?? a.created_at))
    .slice(0, 6);

  const [format, setFormat] = React.useState<ExportFormat>("yaml");
  const [preview, setPreview] = React.useState<Partial<Record<ExportFormat, string>>>({});
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (!project || preview[format] !== undefined) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    cairn
      .getExportText(project.id, format)
      .then((text) => {
        if (cancelled || !alive.current) return;
        setPreview((current) => ({ ...current, [format]: text }));
      })
      .catch((cause: Error) => {
        if (!cancelled && alive.current) setPreviewError(cause.message);
      })
      .finally(() => {
        if (!cancelled && alive.current) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [format, preview, project]);

  const fullText = preview[format] ?? "";
  const previewText = fullText.slice(0, 20_000);

  const copyPreview = async () => {
    if (!fullText) return;
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setPreviewError("Clipboard unavailable in this browser context.");
    }
  };

  if (loading || !detail || !project) {
    return (
      <Card className="p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-4 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-2/3" />
        <Skeleton className="mt-6 h-9 w-40" />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ReportMarkdownCard projectId={project.id} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="flex flex-col gap-6 xl:col-span-2">
          <Card className="gap-0 overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FileTextIcon className="size-4 text-muted-foreground" />
                Report
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge domain="project" value={project.status} dot className="px-1.5 py-0 text-[11px]" />
                <span className="text-[11px] text-muted-foreground">Created {formatDate(project.created_at)}</span>
              </div>
            </div>

            <div className="flex flex-col gap-5 p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <CountTile label="Findings" value={findings.length} />
                <CountTile label="Intents" value={intents.length} />
                <CountTile label="Open intents" value={working + unclaimed} />
                <CountTile label="Hints" value={detail.hints.length} />
              </div>

              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Objective</div>
                <p className="text-xs leading-relaxed text-foreground/90">{goal?.description ?? "No goal recorded."}</p>
              </div>
              <div className="border-t pt-4">
                <div className="mb-1 text-xs font-medium text-muted-foreground">Scope / origin</div>
                <p className="text-xs leading-relaxed text-foreground/90">
                  {origin?.description ?? "No origin recorded."}
                </p>
              </div>
              <div className="border-t pt-3 text-[11px] text-muted-foreground">
                {formatNumber(concluded)} concluded · {formatNumber(working)} working · {formatNumber(unclaimed)} unclaimed
                {workers.length > 0 ? ` · producers ${workers.join(", ")}` : " · no producers recorded"}
              </div>
            </div>
          </Card>

          <Card className="gap-0 overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
              <SparklesIcon className="size-4 text-muted-foreground" />
              Top findings
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                latest {Math.min(topFindings.length, 6)} of {formatNumber(findings.length)}
              </span>
            </div>
            <div className="divide-y">
              {topFindings.map((fact) => (
                <div key={fact.id} className="flex items-start gap-3 px-4 py-2.5">
                  <Badge variant="outline" className="mt-0.5 w-12 shrink-0 justify-center px-1.5 py-0 font-mono text-[11px]">
                    {fact.id}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-xs leading-relaxed text-foreground/90">
                      {oneLine(fact.description)}
                    </div>
                    <div className="mt-1">
                      <ProducerLink producer={producers.get(fact.id)} onOpenGraph={onOpenGraph} />
                    </div>
                  </div>
                  {onOpenGraph && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-7 shrink-0"
                      onClick={() => onOpenGraph(fact.id)}
                      aria-label={`Open ${fact.id} in the exploration graph`}
                    >
                      <GitBranchIcon className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card className="gap-0 overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
              <GitBranchIcon className="size-4 text-muted-foreground" />
              Recent intents
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                latest {Math.min(recentIntents.length, 6)} of {formatNumber(intents.length)}
              </span>
            </div>
            <div className="divide-y">
              {recentIntents.map((intent) => {
                const status = intent.concluded_at ? "concluded" : intent.worker ? "working" : "open";
                return (
                  <div key={intent.id} className="flex items-start gap-3 px-4 py-2.5">
                    <StatusBadge domain="cairnFeed" value={status} dot className="mt-0.5 shrink-0 px-1.5 py-0 text-[11px]" />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-xs leading-relaxed text-foreground/90">
                        {oneLine(intent.description)}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="font-mono">{intent.id}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{intent.worker ?? intent.creator}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatRelative(intent.concluded_at ?? intent.created_at)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card className="gap-0 overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
              <DownloadIcon className="size-4 text-muted-foreground" />
              Export
            </div>
            <div className="flex flex-col gap-3 p-4">
              <div>
                <Button variant="outline" className="w-full justify-start" asChild>
                  <a href={cairn.exportPath(project.id, "yaml")} download={`${project.id}.yaml`}>
                    <DownloadIcon data-icon="inline-start" />
                    Download YAML
                  </a>
                </Button>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Full project state: project, facts, intents and hints.
                </p>
              </div>
              <div>
                <Button variant="outline" className="w-full justify-start" asChild>
                  <a href={cairn.exportPath(project.id, "timeline")} download={`${project.id}.timeline.txt`}>
                    <DownloadIcon data-icon="inline-start" />
                    Download timeline
                  </a>
                </Button>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Chronological transcript of declarations and conclusions.
                </p>
              </div>
              <div className="border-t pt-3">
                <Button variant="outline" className="w-full justify-start" asChild>
                  <Link prefetch={false} href={`/print/projects/${encodeURIComponent(project.id)}`} target="_blank" rel="noreferrer">
                    <PrinterIcon data-icon="inline-start" />
                    Print report
                  </Link>
                </Button>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Opens the dedicated print view, then the browser print dialog (choose “Save as PDF”).
                </p>
              </div>
            </div>
          </Card>

          <Card className="gap-0 overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
              <ClipboardCopyIcon className="size-4 text-muted-foreground" />
              Provenance
            </div>
            <div className="flex flex-col gap-2 p-4 text-[11px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Project</span>
                <span className="font-mono">{project.id}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDate(project.created_at)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Facts</span>
                <span className="tabular-nums">
                  {formatNumber(findings.length)} findings + {formatNumber(PREMISES.size)} premises
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Intents</span>
                <span className="tabular-nums">
                  {formatNumber(concluded)} concluded / {formatNumber(intents.length)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Hints</span>
                <span className="tabular-nums">{formatNumber(detail.hints.length)}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-t pt-2">
                <span className="text-muted-foreground">Formats</span>
                <span className="font-mono">YAML · timeline</span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileTextIcon className="size-4 text-muted-foreground" />
            Export preview
          </div>
          <div className="flex items-center gap-2">
            <Tabs value={format} onValueChange={(value) => setFormat(value as ExportFormat)}>
              <TabsList className="h-8">
                <TabsTrigger value="yaml" className="text-xs">
                  YAML
                </TabsTrigger>
                <TabsTrigger value="timeline" className="text-xs">
                  Timeline
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button size="sm" variant="outline" onClick={() => void copyPreview()} disabled={!fullText}>
              <ClipboardCopyIcon data-icon="inline-start" />
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={cairn.exportPath(project.id, format)} download={`${project.id}.${format === "yaml" ? "yaml" : "timeline.txt"}`}>
                <DownloadIcon data-icon="inline-start" />
                Download
              </a>
            </Button>
          </div>
        </div>

        {previewError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <FileTextIcon />
              <AlertTitle>Preview unavailable</AlertTitle>
              <AlertDescription>
                <span className="font-mono text-[11px]">{previewError}</span>
              </AlertDescription>
            </Alert>
          </div>
        ) : previewLoading || !fullText ? (
          <div className="p-4">
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <>
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words bg-muted/20 p-4 font-mono text-[11px] leading-relaxed">
              {previewText}
            </pre>
            <div className={cn("border-t px-4 py-2 text-[11px] text-muted-foreground")}>
              {fullText.length > previewText.length
                ? `Previewing the first ${formatNumber(previewText.length)} of ${formatNumber(fullText.length)} characters. Download for the full export.`
                : `${formatNumber(fullText.length)} characters.`}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
