"use client";

import * as React from "react";

import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cairn, type Finding, type ProjectDetail } from "@/lib/cairn-api";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

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
] as const;

function findingLabel(finding: Finding): string {
  return finding.title?.trim() || finding.klass?.trim() || "Uncategorized";
}

function Row({
  finding,
  entities,
  onStatus,
}: {
  finding: Finding;
  entities: Map<string, string>;
  onStatus: (finding: Finding, next: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-b last:border-b-0">
      <div className="hover:bg-accent/40 flex w-full items-center gap-3 px-4 py-3 text-sm">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronRightIcon
            className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-90")}
          />
          <StatusBadge domain="severity" value={finding.severity} dot />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{findingLabel(finding)}</span>
            </div>
            <span className="text-muted-foreground truncate text-xs">{finding.summary}</span>
          </div>
        </button>
        {finding.entity_ids.length > 0 && (
          <div className="hidden shrink-0 flex-wrap justify-end gap-1 sm:flex">
            {finding.entity_ids.slice(0, 2).map((entityId) => (
              <code
                key={entityId}
                className="bg-muted max-w-[10rem] truncate rounded px-1.5 py-0.5 font-mono text-xs"
                title={entities.get(entityId) ?? entityId}
              >
                {entities.get(entityId) ?? entityId}
              </code>
            ))}
            {finding.entity_ids.length > 2 && (
              <span className="text-muted-foreground text-xs">+{finding.entity_ids.length - 2}</span>
            )}
          </div>
        )}
        <Select value={finding.status} onValueChange={(value) => onStatus(finding, value)}>
          <SelectTrigger
            size="sm"
            className="h-7 w-28 shrink-0 border-none px-1 shadow-none focus-visible:ring-0"
          >
            <StatusBadge domain="finding" value={finding.status} dot />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectGroup>
              {FINDING_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {statusMeta("finding", status).label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <span className="text-muted-foreground hidden shrink-0 text-xs md:block">
          {new Date(finding.updated_at || finding.created_at).toLocaleString()}
        </span>
      </div>
      {open && (
        <div className="bg-muted/30 px-4 pb-4 pl-11">
          <div className="text-muted-foreground mb-1 text-xs font-medium">Evidence / PoC</div>
          <pre className="bg-background overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
            {finding.evidence || finding.summary || "No evidence recorded."}
          </pre>
          {finding.klass ? (
            <div className="text-muted-foreground mt-2 text-xs">
              Class: <Badge variant="outline">{finding.klass}</Badge>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function FirstClassFindings({
  projectId,
  detail,
  onRefresh,
}: {
  projectId: string;
  detail: ProjectDetail | null;
  onOpenGraph?: (nodeId: string) => void;
  onOpenRetests?: () => void;
  onRefresh: () => void;
}) {
  const findings = React.useMemo(() => detail?.findings ?? [], [detail]);
  const entities = React.useMemo(
    () => new Map((detail?.entities ?? []).map((entity) => [entity.id, entity.label || entity.key])),
    [detail],
  );
  const [direction, setDirection] = React.useState<"asc" | "desc">("desc");

  const items = React.useMemo(
    () =>
      [...findings].sort((a, b) => {
        const compared = Date.parse(a.created_at) - Date.parse(b.created_at);
        if (compared !== 0) return direction === "asc" ? compared : -compared;
        return b.id.localeCompare(a.id, undefined, { numeric: true });
      }),
    [findings, direction],
  );

  const onStatus = React.useCallback(
    async (finding: Finding, next: string) => {
      if (next === finding.status) return;
      try {
        await cairn.patchFinding(projectId, finding.id, { status: next });
        toast.success(`Marked as "${statusMeta("finding", next).label}"`);
        onRefresh();
      } catch (error) {
        toast.error("Update failed: " + (error as Error).message);
      }
    },
    [projectId, onRefresh],
  );

  return (
    <Card className="overflow-hidden py-0">
      <CardContent className="px-0">
        <div className="text-muted-foreground flex items-center border-b px-4 py-2 text-xs">
          <span className="min-w-0 flex-1">Finding</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 outline-none focus-visible:underline"
            aria-label={`The found-at time is currently ${direction === "asc" ? "ascending" : "descending"}; click to flip the sort direction`}
            onClick={() => setDirection((current) => (current === "asc" ? "desc" : "asc"))}
          >
            <span>Found at</span>
            {direction === "asc" ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />}
          </button>
        </div>
        {items.map((finding) => (
          <Row key={finding.id} finding={finding} entities={entities} onStatus={onStatus} />
        ))}
        {items.length === 0 && (
          <p className="text-muted-foreground px-4 py-8 text-center text-sm">
            Neither this task nor its directly linked tasks has a confirmed finding yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
