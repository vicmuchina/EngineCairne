"use client";

import * as React from "react";

import { RotateCcwIcon } from "lucide-react";

import { CairnRetestDialog } from "./cairn-retest-dialog";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { Retest } from "@/lib/cairn-api";
import { formatRelative } from "@/lib/cairn-format";

const statusLabels: Record<string, string> = {
  pending: "Waiting to start",
  running: "Retesting",
  completed: "Done",
  failed: "The retest failed",
  stopped: "Stopped",
};
const verdictLabels: Record<string, string> = {
  reproduced: "Still reproducible",
  fixed: "Fixed",
  inconclusive: "Cannot be confirmed",
};

function isActive(retest: Retest) {
  return retest.status === "pending" || retest.status === "running";
}

export function CairnRetestPanel({
  projectId,
  findingId,
  findingName,
  retests,
  projectCompleted,
  onRefresh,
}: {
  projectId: string;
  findingId: string;
  findingName?: string;
  retests: Retest[];
  projectCompleted?: boolean;
  onRefresh: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const running = retests.find(isActive);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Finding retest</CardTitle>
          <CardDescription>
            Verify the current state in its own conversation, keeping the conclusion and evidence of every retest.
          </CardDescription>
        </div>
        {running ? (
          <Button variant="outline" size="sm" disabled title="A retest is already running for this finding">
            <Spinner data-icon="inline-start" aria-hidden="true" />
            Retesting
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => setOpen(true)}
            disabled={projectCompleted}
            title={projectCompleted ? "This project is completed; resume it to run a retest" : "Queue a retest"}
          >
            <RotateCcwIcon data-icon="inline-start" />
            Start a retest
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {retests.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No retest record yet</EmptyTitle>
              <EmptyDescription>
                Once the fix is deployed, a retest can be started and the new and old evidence compared.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {retests.map((retest) => (
          <div key={retest.id} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={retest.status === "completed" && retest.verdict === "reproduced" ? "destructive" : "secondary"}
              >
                {retest.status === "completed" && retest.verdict
                  ? verdictLabels[retest.verdict] ?? retest.verdict
                  : statusLabels[retest.status] ?? retest.status}
              </Badge>
              <span className="text-muted-foreground text-xs">
                #{retest.id} · {formatRelative(retest.created_at)}
              </span>
            </div>
            {retest.status === "completed" && retest.summary ? (
              <p className="whitespace-pre-wrap break-words text-sm">{retest.summary}</p>
            ) : null}
            {retest.error ? (
              <p className="whitespace-pre-wrap break-words text-destructive text-sm">{retest.error}</p>
            ) : null}
            {retest.notes ? (
              <p className="whitespace-pre-wrap break-words text-muted-foreground text-xs">
                Additional notes: {retest.notes}
              </p>
            ) : null}
            {retest.status === "completed" && retest.evidence ? (
              <details className="min-w-0">
                <summary className="cursor-pointer text-sm">Retest evidence</summary>
                <pre className="bg-muted/40 mt-3 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap break-words">
                  {retest.evidence}
                </pre>
              </details>
            ) : null}
          </div>
        ))}
      </CardContent>
      {open ? (
        <CairnRetestDialog
          projectId={projectId}
          findingId={findingId}
          findingName={findingName}
          onClose={() => setOpen(false)}
          onStarted={() => {
            onRefresh();
          }}
        />
      ) : null}
    </Card>
  );
}
