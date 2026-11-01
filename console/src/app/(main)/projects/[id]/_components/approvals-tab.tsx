"use client";

import * as React from "react";

import Link from "next/link";

import {
  CheckIcon,
  ChevronDownIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  CairnApiError,
  type ApprovalItem,
  type ApprovalList,
  cairn,
} from "@/lib/cairn-api";
import { formatNumber, formatRelative } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

type Filter = "pending" | "approved" | "denied";

const FILTER_LABELS: Array<{ value: Filter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
];

function payloadSummary(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  if (!text || text === "{}") return "No payload";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

export function ApprovalsTab({ projectId }: { projectId: string }) {
  const [filter, setFilter] = React.useState<Filter>("pending");
  const [data, setData] = React.useState<ApprovalList | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const alive = React.useRef(true);

  const load = React.useCallback(
    async (status: Filter = filter) => {
      setActionError(null);
      try {
        const next = await cairn.listProjectApprovals(projectId, status);
        if (!alive.current) return;
        setData(next);
        setError(null);
      } catch (cause) {
        if (alive.current) setError((cause as Error).message);
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [filter, projectId],
  );

  React.useEffect(() => {
    alive.current = true;
    setLoading(true);
    void load(filter);
    if (filter !== "pending") {
      return () => {
        alive.current = false;
      };
    }
    const timer = setInterval(() => void load(filter), 10000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, filter]);

  const decide = async (item: ApprovalItem, action: "approve" | "deny") => {
    setBusyId(item.id);
    setActionError(null);
    try {
      if (action === "approve") {
        await cairn.approveApproval(item.id);
        toast.success("Approval granted", { description: item.action });
      } else {
        await cairn.denyApproval(item.id);
        toast.success("Approval denied", { description: item.action });
      }
      await load();
    } catch (cause) {
      if (cause instanceof CairnApiError && cause.status === 409) {
        toast.error("Approval already decided", { description: "The queue changed; reloading the current state." });
        await load();
      } else {
        const message = (cause as Error).message;
        setActionError(message);
        toast.error("Approval action failed", { description: message });
      }
    } finally {
      setBusyId(null);
    }
  };

  const items = data?.items ?? [];
  const pending = data?.pending ?? 0;

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheckIcon className="size-4 text-muted-foreground" />
          Approvals
          {pending > 0 && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 px-1.5 text-[11px] text-amber-500">
              {formatNumber(pending)} pending
            </Badge>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCwIcon data-icon="inline-start" className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          value={filter}
          onValueChange={(value) => {
            if (value) setFilter(value as Filter);
          }}
        >
          {FILTER_LABELS.map((entry) => (
            <ToggleGroupItem key={entry.value} value={entry.value} className="text-xs">
              {entry.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="text-[11px] text-muted-foreground">Project approval queue</span>
      </div>

      {error && (
        <div className="border-b px-4 py-3">
          <Alert variant="destructive">
            <ShieldCheckIcon />
            <AlertTitle>Approvals unavailable</AlertTitle>
            <AlertDescription>
              <span className="font-mono text-[11px]">{error}</span>
            </AlertDescription>
          </Alert>
        </div>
      )}

      {actionError && (
        <div className="border-b px-4 py-2 text-[11px] text-destructive">{actionError}</div>
      )}

      <div className="divide-y">
        {loading && items.length === 0 ? (
          Array.from({ length: 3 }).map((_, index) => (
            <div key={`approval-skeleton-${index.toString()}`} className="px-4 py-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3 w-2/3" />
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-muted-foreground">
            {filter === "pending"
              ? "No pending approvals for this project. Requests from the main agent land here."
              : filter === "approved"
                ? "No approvals have been approved for this project."
                : "No approvals have been denied for this project."}
          </div>
        ) : (
          items.map((item) => {
            const busy = busyId === item.id;
            return (
              <div key={item.id} className="flex flex-col gap-3 px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{item.action}</span>
                      <StatusBadge domain="cairnFeed" value={item.status} dot className="px-2 py-0.5 text-[11px]" />
                      <Badge variant="outline" className="px-1.5 py-0 font-mono text-[11px]">
                        #{item.id}
                      </Badge>
                      {item.project_id && (
                        <Link
                          prefetch={false}
                          href={`/projects/${item.project_id}`}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          {item.project_id}
                        </Link>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <span>requested by {item.requested_by}</span>
                      <span className="text-muted-foreground/50">·</span>
                      <span title={new Date(item.requested_at).toLocaleString()}>
                        {formatRelative(item.requested_at)}
                      </span>
                      {item.conversation_id && (
                        <>
                          <span className="text-muted-foreground/50">·</span>
                          <span>conversation #{item.conversation_id}</span>
                        </>
                      )}
                      {item.expires_at && (
                        <>
                          <span className="text-muted-foreground/50">·</span>
                          <span>expires {formatRelative(item.expires_at)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {item.status === "pending" && (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void decide(item, "deny")}
                        disabled={busy}
                      >
                        {busy ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <XIcon data-icon="inline-start" />}
                        Deny
                      </Button>
                      <Button size="sm" onClick={() => void decide(item, "approve")} disabled={busy}>
                        {busy ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <CheckIcon data-icon="inline-start" />}
                        Approve
                      </Button>
                    </div>
                  )}
                </div>

                <details className="group rounded-lg border bg-muted/20">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                    <span className="truncate font-mono">{payloadSummary(item.payload)}</span>
                    <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <pre className="max-h-48 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(item.payload, null, 2)}
                  </pre>
                </details>

                {item.decided_at && (
                  <div className="text-[11px] text-muted-foreground">
                    {item.status} by {item.decided_by ?? "unknown"} ·{" "}
                    {new Date(item.decided_at).toLocaleString()}
                    {item.decision_note ? ` · ${item.decision_note}` : ""}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
