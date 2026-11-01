"use client";

import * as React from "react";

import {
  ActivityIcon,
  ArrowDownWideNarrowIcon,
  ArrowUpWideNarrowIcon,
  BoxesIcon,
  BugIcon,
  ChevronDownIcon,
  FileTextIcon,
  GitBranchIcon,
  LightbulbIcon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  TargetIcon,
  WrenchIcon,
} from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { deriveActivityItems } from "@/lib/cairn-activity";
import { CairnApiError, cairn, type ProjectActivityItem, type ProjectDetail } from "@/lib/cairn-api";
import {
  type BroadcastEvent,
  type BroadcastType,
  buildBroadcastEvents,
  dateKey,
  dateLabel,
  timestampOf,
} from "@/lib/cairn-broadcast";
import { formatNumber, formatRelative } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

type TypeFilter = "all" | BroadcastType;
type SortOrder = "newest" | "oldest";

const FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "goal", label: "Goal" },
  { value: "intent", label: "Intent" },
  { value: "fact", label: "Fact" },
  { value: "finding", label: "Finding" },
  { value: "hint", label: "Hint" },
  { value: "tool", label: "Tool" },
  { value: "entity", label: "Entity" },
  { value: "retest", label: "Retest" },
  { value: "status", label: "Status" },
];

const TYPE_META: Record<
  BroadcastType,
  { label: string; icon: React.ElementType; circle: string; text: string; badge: string }
> = {
  goal: {
    label: "Goal",
    icon: TargetIcon,
    circle: "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    text: "text-emerald-600 dark:text-emerald-400",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  intent: {
    label: "Intent",
    icon: GitBranchIcon,
    circle: "border-blue-500/40 bg-blue-500/15 text-blue-600 dark:text-blue-400",
    text: "text-blue-600 dark:text-blue-400",
    badge: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  fact: {
    label: "Fact",
    icon: FileTextIcon,
    circle: "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400",
    text: "text-amber-600 dark:text-amber-400",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  finding: {
    label: "Finding",
    icon: BugIcon,
    circle: "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400",
    text: "text-rose-600 dark:text-rose-400",
    badge: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  hint: {
    label: "Hint",
    icon: LightbulbIcon,
    circle: "border-violet-500/40 bg-violet-500/15 text-violet-600 dark:text-violet-400",
    text: "text-violet-600 dark:text-violet-400",
    badge: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  entity: {
    label: "Entity",
    icon: BoxesIcon,
    circle: "border-slate-500/40 bg-slate-500/15 text-slate-600 dark:text-slate-300",
    text: "text-slate-600 dark:text-slate-300",
    badge: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
  },
  retest: {
    label: "Retest",
    icon: RotateCcwIcon,
    circle: "border-indigo-500/40 bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    text: "text-indigo-600 dark:text-indigo-400",
    badge: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  },
  tool: {
    label: "Tool",
    icon: WrenchIcon,
    circle: "border-slate-500/40 bg-slate-500/15 text-slate-600 dark:text-slate-400",
    text: "text-slate-600 dark:text-slate-400",
    badge: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400",
  },
  status: {
    label: "Status",
    icon: ActivityIcon,
    circle: "border-border bg-muted text-muted-foreground",
    text: "text-muted-foreground",
    badge: "border-border bg-muted/50 text-muted-foreground",
  },
};

const STATUS_META: Record<string, { label: string; className: string }> = {
  confirmed: {
    label: "Confirmed",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  done: {
    label: "Done",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  working: {
    label: "Working",
    className: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  unclaimed: {
    label: "Unclaimed",
    className: "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300",
  },
  error: {
    label: "Failed",
    className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  timeout: {
    label: "Timed out",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
};

function statusMeta(value: string | null) {
  if (!value) return null;
  return (
    STATUS_META[value.toLowerCase()] ?? {
      label: value.replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      className: "border-border bg-muted/50 text-muted-foreground",
    }
  );
}

function localTime(timestamp: string | null): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function mergeItems(current: ProjectActivityItem[], incoming: ProjectActivityItem[]): ProjectActivityItem[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

function EventRow({ event, onOpenGraph }: { event: BroadcastEvent; onOpenGraph?: (nodeId: string) => void }) {
  const [expanded, setExpanded] = React.useState(false);
  const meta = TYPE_META[event.type];
  const Icon = meta.icon;
  const status = statusMeta(event.status);
  const text = event.description || event.title;
  const long = text.length > 220 || event.description.includes("\n");
  const clickable = Boolean(event.nodeId && (event.type === "intent" || event.type === "fact"));

  const openGraph = () => {
    if (clickable && event.nodeId) onOpenGraph?.(event.nodeId);
  };

  return (
    <div className="relative flex gap-2 pb-4">
      <div className="flex w-[74px] shrink-0 flex-col items-end pt-1 text-right">
        <time
          className="font-mono text-[11px] tabular-nums text-muted-foreground"
          title={event.timestamp ? new Date(event.timestamp).toLocaleString() : "No timestamp recorded"}
          suppressHydrationWarning
        >
          {localTime(event.timestamp)}
        </time>
        <span className="text-[10px] text-muted-foreground/80" suppressHydrationWarning>
          {event.timestamp ? formatRelative(event.timestamp) : "no timestamp"}
        </span>
      </div>

      <div className="relative flex min-w-0 flex-1 gap-3">
        <span className="absolute bottom-0 left-[13px] top-7 w-px bg-border" aria-hidden />
        <span
          className={cn(
            "relative z-10 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
            meta.circle,
          )}
        >
          <Icon className="size-3.5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-xs font-semibold", meta.text)}>{meta.label}</span>
            <span className="font-mono text-[11px] text-muted-foreground">#{event.id}</span>
            {status && (
              <span
                className={cn(
                  "inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-medium whitespace-nowrap",
                  status.className,
                )}
              >
                {status.label}
              </span>
            )}
            {clickable && <GitBranchIcon className="size-3 text-muted-foreground/70" aria-label="Opens the graph" />}
            <span className="ml-auto max-w-[45%] truncate text-[11px] text-muted-foreground" title={event.author}>
              {event.author}
            </span>
          </div>

          <div
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? openGraph : undefined}
            onKeyDown={
              clickable
                ? (keyEvent) => {
                    if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                      keyEvent.preventDefault();
                      openGraph();
                    }
                  }
                : undefined
            }
            className={cn(
              "mt-1 min-w-0 text-xs leading-relaxed text-foreground/90 [overflow-wrap:anywhere]",
              clickable && "cursor-pointer rounded-sm hover:text-foreground",
              !expanded && "line-clamp-3 whitespace-pre-wrap",
              expanded && "whitespace-pre-wrap",
            )}
          >
            {text}
          </div>
          {long && (
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={(buttonEvent) => {
                buttonEvent.stopPropagation();
                setExpanded((value) => !value);
              }}
            >
              <ChevronDownIcon className={cn("size-3 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Show less" : "Show full text"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function BroadcastTab({
  projectId,
  projectTitle,
  detail,
  onOpenGraph,
}: {
  projectId: string;
  projectTitle?: string;
  detail?: ProjectDetail | null;
  onOpenGraph?: (nodeId: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<TypeFilter>("all");
  const [order, setOrder] = React.useState<SortOrder>("newest");
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [items, setItems] = React.useState<ProjectActivityItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [derived, setDerived] = React.useState(false);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const alive = React.useRef(true);
  const inFlight = React.useRef(false);
  const cursor = React.useRef<string | null>(null);
  const loadedOlder = React.useRef(false);
  const detailRef = React.useRef<ProjectDetail | null>(detail ?? null);
  detailRef.current = detail ?? null;
  const loadedProject = React.useRef<string | null>(null);

  /**
   * Artex loads the newest page first, then walks backwards on demand. The engine feed is
   * ascending, so "newest" is a dedicated tail query and `before=<cursor>` pages older.
   * `compact` bounds tool metadata; a 6.8k-activity project dropped from 23 MB to <1 MB per
   * page and the skeleton clears after the first 300 rows.
   */
  const load = React.useCallback(
    async (mode: "refresh" | "older") => {
      if (!projectId || inFlight.current) return;
      inFlight.current = true;
      if (mode === "older") setLoadingMore(true);
      else setRefreshing(true);
      try {
        const feed =
          mode === "older"
            ? await cairn.getProjectActivity(projectId, {
                limit: 300,
                compact: true,
                before: cursor.current ?? undefined,
              })
            : await cairn.getProjectActivity(projectId, {
                limit: 300,
                compact: true,
                newestFirst: true,
              });
        if (!alive.current) return;
        setItems((current) => (current.length ? mergeItems(current, feed.items) : feed.items));
        if (feed.next_cursor) cursor.current = feed.next_cursor;
        if (mode === "older") {
          loadedOlder.current = true;
          setHasMore(feed.has_more);
        } else if (!loadedOlder.current) {
          setHasMore(feed.has_more);
        }
        setDerived(false);
        setError(null);
        setUpdatedAt(new Date());
      } catch (cause) {
        if (!alive.current) return;
        if (cause instanceof CairnApiError && cause.status === 404 && detailRef.current) {
          setItems(deriveActivityItems(detailRef.current));
          setHasMore(false);
          setDerived(true);
          setError(null);
          setUpdatedAt(new Date());
        } else {
          setError((cause as Error).message);
        }
      } finally {
        inFlight.current = false;
        if (alive.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [projectId],
  );

  React.useEffect(() => {
    alive.current = true;
    if (loadedProject.current !== projectId) {
      loadedProject.current = projectId;
      cursor.current = null;
      loadedOlder.current = false;
      setItems([]);
      setLoading(true);
      setDerived(false);
      setError(null);
    }
    void load("refresh");
    if (!autoRefresh) {
      return () => {
        alive.current = false;
      };
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load("refresh");
    }, 3000);
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") void load("refresh");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoRefresh, load, projectId]);

  const events = React.useMemo(() => buildBroadcastEvents(items, detail ?? null), [items, detail]);

  const grouped = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = events.filter((event) => {
      if (kind !== "all" && event.type !== kind) return false;
      if (!needle) return true;
      return (
        event.description.toLowerCase().includes(needle) ||
        event.title.toLowerCase().includes(needle) ||
        event.id.toLowerCase().includes(needle) ||
        event.author.toLowerCase().includes(needle) ||
        TYPE_META[event.type].label.toLowerCase().includes(needle) ||
        (projectTitle ?? "").toLowerCase().includes(needle)
      );
    });
    const direction = order === "newest" ? -1 : 1;
    matched.sort((a, b) => {
      const at = timestampOf(a);
      const bt = timestampOf(b);
      if (at === null && bt === null) return a.key.localeCompare(b.key);
      if (at === null) return 1;
      if (bt === null) return -1;
      return (at - bt) * direction;
    });
    const groups: Array<{ key: string; label: string; events: BroadcastEvent[] }> = [];
    for (const event of matched) {
      const key = dateKey(event.timestamp);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.events.push(event);
      else groups.push({ key, label: dateLabel(event.timestamp), events: [event] });
    }
    return groups;
  }, [events, kind, order, projectTitle, query]);

  const visible = grouped.reduce((total, group) => total + group.events.length, 0);

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ActivityIcon className="size-4 text-muted-foreground" />
          Broadcast board
          <span className="rounded border bg-muted/40 px-1.5 py-0 text-[11px] font-normal text-muted-foreground">
            {formatNumber(visible)} of {formatNumber(events.length)}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{updatedAt ? `updated ${formatRelative(updatedAt.toISOString())}` : "loading…"}</span>
          <Button size="sm" variant="outline" onClick={() => void load("refresh")} disabled={refreshing}>
            <RefreshCwIcon data-icon="inline-start" className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b px-4 py-3">
          <Alert variant="destructive">
            <ActivityIcon />
            <AlertTitle>Activity feed unavailable</AlertTitle>
            <AlertDescription>
              <span className="break-all font-mono text-[11px]">{error}</span>
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => void load("refresh")}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )}

      {derived && (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          The unified activity endpoint is unavailable; this board is showing the fact graph snapshot only.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(changeEvent) => setQuery(changeEvent.target.value)}
            placeholder="Search the broadcast board…"
            className="h-8 pl-8 text-xs"
            aria-label="Search broadcast events"
          />
        </div>

        <div className="min-w-0 max-w-full overflow-x-auto">
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            value={kind}
            onValueChange={(value) => {
              if (value) setKind(value as TypeFilter);
            }}
            className="w-max"
          >
            {FILTERS.map((filter) => (
              <ToggleGroupItem key={filter.value} value={filter.value} className="text-xs">
                {filter.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <Select value={order} onValueChange={(value) => setOrder(value as SortOrder)}>
          <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Sort broadcast events">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest" className="text-xs">
              <ArrowDownWideNarrowIcon className="size-3.5" />
              Newest first
            </SelectItem>
            <SelectItem value="oldest" className="text-xs">
              <ArrowUpWideNarrowIcon className="size-3.5" />
              Oldest first
            </SelectItem>
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} aria-label="Auto-refresh broadcast" />
          <span>Auto-refresh</span>
        </div>
      </div>

      <div className="max-h-[72vh] overflow-y-auto px-4 pt-3">
        {loading && items.length === 0 ? (
          <div className="divide-y pb-4">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={`broadcast-skeleton-${index.toString()}`} className="py-3">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="mt-2 h-3 w-full" />
              </div>
            ))}
          </div>
        ) : events.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">No broadcast events yet.</div>
        ) : visible === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">No events match this search or filter.</div>
        ) : (
          grouped.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <div className="sticky top-0 z-20 -mx-4 flex items-center gap-2 bg-card/95 px-4 py-2 backdrop-blur">
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">{group.label}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              {group.events.map((event) => (
                <EventRow key={event.key} event={event} onOpenGraph={onOpenGraph} />
              ))}
            </section>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-[11px] text-muted-foreground">
        <span>
          {formatNumber(visible)} of {formatNumber(events.length)} events
        </span>
        <div className="flex items-center gap-3">
          {hasMore && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => void load("older")}
              disabled={loadingMore}
            >
              {loadingMore ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : null}
              Load older events
            </Button>
          )}
          <span>
            {autoRefresh ? "Auto-refresh every 3s" : "Auto-refresh paused"}
            {hasMore ? " · older history available" : ""}
          </span>
        </div>
      </div>
    </Card>
  );
}
