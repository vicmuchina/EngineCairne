"use client";

import Link from "next/link";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import type { ProjectActivityItem } from "@/lib/cairn-api";
import { formatRelative, oneLine } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

const KIND_META: Record<string, { label: string; className: string }> = {
  goal: {
    label: "Goal",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  fact: {
    label: "Fact",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  intent: {
    label: "Intent",
    className: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  hint: {
    label: "Hint",
    className: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  tool: {
    label: "Tool",
    className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  },
  chat: {
    label: "Chat",
    className: "border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400",
  },
  approval: {
    label: "Approval",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  steering: {
    label: "Steering",
    className: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  },
  project: {
    label: "Project",
    className: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400",
  },
  compaction: {
    label: "Compaction",
    className: "border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400",
  },
  error: {
    label: "Error",
    className: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  },
};

function kindMeta(kind: string) {
  return (
    KIND_META[kind] ?? {
      label: kind.replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      className: "border-border bg-muted/40 text-muted-foreground",
    }
  );
}

/**
 * Runtime v2 project activity feed. Rows: time, type badge, id, status, actor,
 * project (optional), description. Shared by the dashboard, Overview preview
 * and Broadcast board.
 */
export function CairnActivityFeed({
  items,
  projectTitles = {},
  showProject = true,
  linkProject = false,
  empty = "No activity recorded yet.",
}: {
  items: readonly ProjectActivityItem[];
  projectTitles?: Record<string, string>;
  showProject?: boolean;
  linkProject?: boolean;
  empty?: string;
}) {
  if (items.length === 0) {
    return <div className="py-10 text-center text-xs text-muted-foreground">{empty}</div>;
  }

  return (
    <div className="divide-y">
      {items.map((item) => {
        const meta = kindMeta(item.kind);
        const projectLabel = projectTitles[item.project_id] ?? item.project_id;
        const actor = item.actor ?? "system";
        const time = item.timestamp ? formatRelative(item.timestamp) : "—";
        const timeTitle = item.timestamp
          ? `${new Date(item.timestamp).toLocaleString()} · ${item.timestamp_source}`
          : item.timestamp_source;

        const body = (
          <div className="flex items-start gap-3 py-3">
            <span
              className="w-14 shrink-0 pt-0.5 text-[11px] text-muted-foreground tabular-nums"
              title={timeTitle}
            >
              {time}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge
                  variant="outline"
                  className={cn("px-1.5 py-0 text-[11px] font-medium", meta.className)}
                >
                  {meta.label}
                </Badge>
                <span className="max-w-40 truncate font-mono text-[11px] text-muted-foreground" title={item.id}>
                  {item.id}
                </span>
                {item.status && (
                  <StatusBadge domain="cairnFeed" value={item.status} dot className="px-1.5 py-0 text-[11px]" />
                )}
                <span className="truncate text-[11px] text-muted-foreground">
                  {actor}
                  {showProject ? ` · ${projectLabel}` : ""}
                </span>
              </div>
              <div className="mt-1 line-clamp-2 text-xs leading-snug text-foreground/90">
                {oneLine(item.description ?? item.title)}
              </div>
            </div>
          </div>
        );

        if (!linkProject) {
          return <div key={`${item.id}-${item.cursor ?? ""}-${item.timestamp ?? ""}-${item.status ?? ""}`}>{body}</div>;
        }

        return (
          <Link
            key={`${item.id}-${item.cursor ?? ""}-${item.timestamp ?? ""}-${item.status ?? ""}`}
            prefetch={false}
            href={`/projects/${item.project_id}`}
            className="-mx-2 block rounded-md px-2 transition-colors hover:bg-muted/40"
          >
            {body}
          </Link>
        );
      })}
    </div>
  );
}
