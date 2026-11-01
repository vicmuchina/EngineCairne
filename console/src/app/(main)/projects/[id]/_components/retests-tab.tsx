"use client";

import * as React from "react";

import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { CairnRetestPanel } from "./cairn-retest-panel";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectDetail } from "@/lib/cairn-api";

const PAGE_SIZE = 20;

function findingLabel(finding: { title: string; klass: string }) {
  return finding.title?.trim() || finding.klass?.trim() || "Uncategorized";
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
  const [page, setPage] = React.useState(1);
  const [selectedId, setSelectedId] = React.useState("");

  const lastPage = Math.max(1, Math.ceil(findings.length / PAGE_SIZE));
  const activePage = Math.min(page, lastPage);
  const pageFindings = findings.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);

  React.useEffect(() => {
    setSelectedId((current) =>
      pageFindings.some((finding) => finding.id === current) ? current : (pageFindings[0]?.id ?? ""),
    );
  }, [pageFindings]);

  const selected = pageFindings.find((finding) => finding.id === selectedId);
  const selectedRetests = React.useMemo(
    () => (detail?.retests ?? []).filter((retest) => retest.finding_id === selectedId),
    [detail, selectedId],
  );
  const projectCompleted = detail?.project.status === "completed";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Pick a finding{findings.length ? ` - ${findings.length}` : ""}</CardTitle>
            <CardDescription>Look at the retest records of this task's findings, or start a new retest.</CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-[32rem] flex-col overflow-y-auto">
            {loading && !detail ? <Skeleton className="h-24 w-full" /> : null}
            {pageFindings.map((finding, index) => (
              <React.Fragment key={finding.id}>
                {index > 0 ? <Separator className="my-1" /> : null}
                <Button
                  variant={finding.id === selectedId ? "secondary" : "ghost"}
                  className="h-auto w-full shrink-0 flex-col items-start gap-2 whitespace-normal py-3 text-left"
                  aria-label={`Pick the finding: ${findingLabel(finding)}`}
                  aria-pressed={finding.id === selectedId}
                  onClick={() => setSelectedId(finding.id)}
                >
                  <span className="line-clamp-2 break-words">{findingLabel(finding)}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge domain="severity" value={finding.severity} dot />
                    <StatusBadge domain="finding" value={finding.status} dot />
                  </span>
                </Button>
              </React.Fragment>
            ))}
            {!loading && findings.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No finding available to retest</EmptyTitle>
                  <EmptyDescription>Once this task records a finding, a retest can be started here by hand.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
          </CardContent>
          {findings.length > PAGE_SIZE ? (
            <CardFooter className="justify-between gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous page of findings"
                disabled={activePage === 1}
                onClick={() => setPage(activePage - 1)}
              >
                <ChevronLeftIcon />
              </Button>
              <span className="text-muted-foreground text-xs">
                Page {activePage} / {lastPage}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next page of findings"
                disabled={activePage * PAGE_SIZE >= findings.length}
                onClick={() => setPage(activePage + 1)}
              >
                <ChevronRightIcon />
              </Button>
            </CardFooter>
          ) : null}
        </Card>
        {selected ? (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 className="min-w-0 flex-1 break-words font-medium">{findingLabel(selected)}</h2>
                <Button variant="ghost" size="sm" onClick={onOpenFindings}>
                  Open findings <ArrowUpRightIcon data-icon="inline-end" />
                </Button>
              </div>
              <p className="line-clamp-3 break-words text-muted-foreground text-sm">{selected.summary}</p>
            </div>
            <CairnRetestPanel
              key={selected.id}
              projectId={projectId}
              findingId={selected.id}
              findingName={findingLabel(selected)}
              retests={selectedRetests}
              projectCompleted={projectCompleted}
              onRefresh={onRefresh}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
