"use client";

import * as React from "react";

import {
  AlertTriangleIcon,
  ArrowUpIcon,
  BrainIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  HistoryIcon,
  Loader2Icon,
  PauseIcon,
  RadioIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
  UserIcon,
  WifiOffIcon,
  ZapOffIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Transcript } from "@/components/transcript";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type CairnSession,
  collapseWorkerSessions,
  fetchSessionActivities,
  fetchSessions,
  mergeActivities,
  orderWorkerSessions,
  type SessionActivity,
  type SessionInterruption,
  sendMainMessage,
  sessionTokens,
  stopMainTurn,
} from "@/lib/cairn-sessions";
import { shouldSubmitOnKey, useChatSendMode } from "@/lib/chat-send-mode";
import { cn } from "@/lib/utils";

// ── formatting helpers (same compact shapes as Artex) ──────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

const roleMeta = {
  mainagent: { label: "Main agent", icon: UserIcon },
  planner: { label: "Planner", icon: BrainIcon },
  worker: { label: "Workers", icon: RadioIcon },
  system: { label: "System audit", icon: HistoryIcon },
} as const;

function statusIcon(status: string) {
  switch (status) {
    case "running":
    case "streaming":
      return <Loader2Icon className="size-3.5 animate-spin text-blue-500" />;
    case "paused":
      return <PauseIcon className="size-3.5 text-amber-500" />;
    case "pending":
    case "queued":
      return <ClockIcon className="size-3.5 text-muted-foreground" />;
    case "done":
    case "success":
      return <CircleCheckIcon className="size-3.5 text-emerald-500" />;
    case "stopped":
    case "cancelled":
      return <CircleSlashIcon className="size-3.5 text-amber-500" />;
    case "blocked":
    case "error":
    case "failed":
      return <CircleXIcon className="size-3.5 text-red-500" />;
    case "exhausted":
      return <ZapOffIcon className="size-3.5 text-violet-500" />;
    case "stale":
      return <CircleSlashIcon className="size-3.5 text-muted-foreground" />;
    default:
      return <span className="size-1.5 rounded-full bg-muted-foreground/40" />;
  }
}

const TokenMetrics = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span"> & {
    input: number;
    cache: number;
    output: number;
    labels?: "short" | "long";
    compact?: boolean;
  }
>(({ input, cache, output, labels = "short", compact = false, className, ...props }, ref) => {
  const names = labels === "short" ? ["in", "cache", "out"] : ["input", "cache", "output"];
  const values = [input, cache, output];
  return (
    <span
      ref={ref}
      className={cn("inline-flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground", className)}
      {...props}
    >
      {values.map((value, index) => (
        <React.Fragment key={names[index]}>
          <span>{names[index]}</span>
          <Badge
            variant="secondary"
            className={cn("h-5 px-1.5 font-mono tabular-nums", compact && "h-4 px-1 text-[10px]")}
          >
            {fmtTokens(value)}
          </Badge>
        </React.Fragment>
      ))}
    </span>
  );
});
TokenMetrics.displayName = "TokenMetrics";

// ── transcript mapping: Cairn session activity -> the fork's Transcript row ──

type TranscriptActivity = React.ComponentProps<typeof Transcript>["activity"][number];

function metaText(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// pi's final worker message is the task protocol JSON. Artex shows the human
// conclusion, not the envelope, so unwrap `data.fact.description` /
// `data.complete.description` / the first proposed intent before rendering.
function stripMarkdownLite(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function intentBlock(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const rows: string[] = [];
  for (const item of value) {
    const intent = asRecord(item);
    if (!intent) continue;
    const description = asText(intent.description);
    if (!description) continue;
    const from = Array.isArray(intent.from) ? intent.from.filter((entry) => typeof entry === "string").join(", ") : "";
    rows.push(from ? `- ${from} → ${description}` : `- ${description}`);
  }
  return rows.length ? `Proposed ${rows.length} intent${rows.length === 1 ? "" : "s"}:\n\n${rows.join("\n")}` : null;
}

// pi's worker/planner messages are task-protocol JSON envelopes. Artex shows the
// human conclusion, never the envelope, so unwrap the useful prose and ignore
// frames that carry no prose at all (the Summary card then says so honestly).
function humanizeWorkerText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return stripMarkdownLite(trimmed);
  try {
    const parsed = asRecord(JSON.parse(trimmed));
    if (!parsed) return stripMarkdownLite(trimmed);
    const data = asRecord(parsed.data);
    const complete = data?.complete ?? parsed.complete;
    const completeRecord = asRecord(complete);
    const factRecord = asRecord(data?.fact ?? parsed.fact);
    const candidate =
      asText(completeRecord?.description) ||
      asText(completeRecord?.fact) ||
      asText(factRecord?.description) ||
      asText(data?.description) ||
      asText(parsed.description) ||
      asText(parsed.summary) ||
      asText(complete) ||
      intentBlock(data?.intents) ||
      intentBlock(parsed.intents);
    if (candidate) return stripMarkdownLite(candidate);
    if (complete === true || data?.complete === true) return "Goal satisfied.";
    return "";
  } catch {
    // A truncated envelope is not valid JSON. If it still looks like one, do not
    // leak the raw braces into the transcript; otherwise show the plain text.
    return trimmed.startsWith("{") ? "" : stripMarkdownLite(trimmed);
  }
}

function systemText(activity: SessionActivity): string {
  const content = activity.content?.trim();
  if (content) return content;
  const meta = activity.metadata;
  const from = metaText(meta, "from");
  const to = metaText(meta, "to");
  if (from && to) return `Project status: ${from} → ${to}`;
  const title = metaText(meta, "title");
  if (title) return title;
  const message = metaText(meta, "message");
  if (message) return message;
  return activity.kind.replace(/[_-]/g, " ");
}

function mapSessionActivity(
  activity: SessionActivity,
  session: CairnSession,
  isMain: boolean,
): TranscriptActivity | null {
  const base = {
    seq: activity.seq,
    worker: session.key,
    ts: activity.created_at || session.last_activity_at || "",
    detail: "",
  };
  const tool = activity.tool ?? null;

  switch (activity.kind) {
    case "tool_call":
    case "tool_use": {
      const input = tool?.input ?? activity.content ?? "";
      return {
        ...base,
        kind: "tool_use",
        tool: tool?.name ?? "tool",
        tool_use_id: tool?.call_id ?? undefined,
        is_error: Boolean(tool?.is_error),
        summary: input,
        detail: input,
      };
    }
    case "tool_result": {
      const output = tool?.output ?? activity.content ?? "";
      return {
        ...base,
        kind: "tool_result",
        tool: tool?.name ?? "tool",
        tool_use_id: tool?.call_id ?? undefined,
        is_error: Boolean(tool?.is_error) || activity.status === "error",
        summary: output,
        detail: output,
      };
    }
    case "thinking": {
      const content = activity.content ?? "";
      return { ...base, kind: "thinking", summary: content, detail: content };
    }
    case "message": {
      const role = activity.role ?? "assistant";
      if (role === "user") {
        return {
          ...base,
          kind: "user",
          summary: activity.content ?? "",
          detail: activity.content ?? "",
        };
      }
      return {
        ...base,
        kind: isMain ? "text" : "result",
        summary: humanizeWorkerText(activity.content ?? ""),
        detail: humanizeWorkerText(activity.content ?? ""),
        is_error: activity.status === "error",
      };
    }
    case "error": {
      const text = activity.content ?? metaText(activity.metadata, "error") ?? "The run failed.";
      return { ...base, kind: "result", summary: text, detail: text, is_error: true };
    }
    case "usage":
    case "interruption":
      return null;
    case "result":
    case "text": {
      const text = activity.content ?? "";
      return {
        ...base,
        kind: activity.kind,
        summary: text,
        detail: text,
        is_error: activity.status === "error",
      };
    }
    case "user":
    case "intent": {
      return {
        ...base,
        kind: "user",
        summary: activity.content ?? "",
        detail: activity.content ?? "",
      };
    }
    default: {
      // status / worker_output / project / import events are real audit prose.
      const text = systemText(activity);
      return {
        ...base,
        kind: "result",
        summary: text,
        detail: text,
        is_error: activity.status === "error",
      };
    }
  }
}

function workerObjective(session: CairnSession): string {
  const title = session.title.trim();
  return title.replace(/^#\S+\s+/, "").trim() || title;
}

function buildTranscript(items: readonly SessionActivity[], session: CairnSession | null): TranscriptActivity[] {
  if (!session) return [];
  const isMain = session.role === "mainagent";
  const rows: TranscriptActivity[] = [];
  if (session.role === "planner" && (session.round ?? 0) > 0) {
    // The backend exposes the latest round; earlier rounds are not in the
    // transcript payload, so this divider marks the current planning round.
    rows.push({
      seq: Number.MIN_SAFE_INTEGER,
      worker: session.key,
      ts: session.started_at ?? session.last_activity_at ?? "",
      kind: "round",
      summary: `planning round ${session.round}`,
      detail: "",
    });
  }
  if (session.role === "worker") {
    // The objective leads the worker transcript, exactly like Artex's intent bubble.
    rows.push({
      seq: Number.MIN_SAFE_INTEGER,
      worker: session.key,
      ts: session.started_at ?? session.last_activity_at ?? "",
      kind: "intent",
      summary: workerObjective(session),
      detail: workerObjective(session),
    });
  }

  // When the planner round summary exists, the final assistant message is the
  // raw plan envelope. The Round summary card carries the human version, so the
  // envelope is omitted rather than rendered as a duplicate Summary card.
  let skipSeq: number | null = null;
  if (session.role === "planner" && session.summary) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "message" && item.role !== "user") {
        skipSeq = item.seq;
        break;
      }
    }
  }

  let finalMessageIndex: number | null = null;
  items.forEach((item) => {
    if (item.seq === skipSeq) return;
    const row = mapSessionActivity(item, session, isMain);
    if (!row) return;
    rows.push(row);
    if (
      session.role === "worker" &&
      !session.interrupted &&
      !session.queued &&
      item.kind === "message" &&
      item.role !== "user"
    ) {
      finalMessageIndex = rows.length - 1;
    }
  });
  if (finalMessageIndex !== null) {
    const row = rows[finalMessageIndex];
    if (row && (row.kind === "result" || row.kind === "text")) row.kind = "summary";
  }
  return rows;
}

function elapsedMs(session: CairnSession | null, items: readonly SessionActivity[], now: number): number | null {
  if (!session) return null;
  if (!session.live && typeof session.duration_ms === "number" && session.duration_ms >= 0) return session.duration_ms;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  const consider = (value: string | null | undefined) => {
    if (!value) return;
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return;
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  };
  consider(session.started_at);
  for (const item of items) consider(item.created_at);
  consider(session.last_activity_at);
  consider(session.finished_at);
  if (!Number.isFinite(min) || max === 0) return null;
  const end = session.live ? now : max;
  return Math.max(0, end - min);
}

// ── interruption + round summary cards ────────────────────────────────────

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeInterruption(value: unknown): SessionInterruption | null {
  const record = asRecord(value);
  if (!record) return null;
  const usage = asRecord(record.usage);
  const tool = asRecord(record.tool);
  return {
    reason: asText(record.reason),
    terminal_state: asText(record.terminal_state),
    turns: numberField(record.turns),
    duration_ms: numberField(record.duration_ms),
    usage: usage
      ? {
          input: numberField(usage.input) ?? undefined,
          output: numberField(usage.output) ?? undefined,
          cache_read: numberField(usage.cache_read) ?? undefined,
        }
      : null,
    tool: tool
      ? {
          name: asText(tool.name),
          call_id: asText(tool.call_id),
          input: asText(tool.input),
        }
      : null,
    text: asText(record.text),
    run_id: asText(record.run_id),
  };
}

/** The tool that never got a paired result (the one in flight at interruption). */
function openToolInFlight(items: readonly SessionActivity[]): SessionInterruption["tool"] {
  const open = new Map<string, { name: string | null; call_id: string | null; input: string | null }>();
  for (const item of items) {
    const callId = item.tool?.call_id ?? null;
    if (!callId) continue;
    if (item.kind === "tool_call") {
      open.set(callId, {
        name: item.tool?.name ?? null,
        call_id: callId,
        input: item.tool?.input ?? null,
      });
    } else if (item.kind === "tool_result") {
      open.delete(callId);
    }
  }
  const values = [...open.values()];
  return values.length ? values[values.length - 1] : null;
}

function interruptionFor(session: CairnSession | null, items: readonly SessionActivity[]): SessionInterruption | null {
  if (!session) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const activity = items[index];
    if (activity.kind !== "interruption") continue;
    const content = activity.content?.trim() ?? "";
    if (content.startsWith("{")) {
      try {
        const parsed = normalizeInterruption(JSON.parse(content));
        if (parsed) return parsed;
      } catch {
        // plain prose that merely starts with a brace
      }
    }
    const metadata = activity.metadata ?? {};
    const embedded = normalizeInterruption(metadata.interruption) ?? normalizeInterruption(metadata.report);
    return {
      ...(embedded ?? {}),
      reason: embedded?.reason ?? asText(metadata.reason),
      terminal_state: embedded?.terminal_state ?? asText(metadata.terminal_state) ?? activity.status ?? null,
      text: embedded?.text ?? (content || null),
    };
  }
  const summaryInterruption = normalizeInterruption(session.summary?.interruption);
  if (summaryInterruption) return summaryInterruption;
  if (!session.interrupted) return null;

  const usage = session.usage ?? session.tokens ?? {};
  return {
    reason: session.interrupt_reason ?? session.status,
    terminal_state: session.status,
    turns: session.counts?.messages ?? null,
    duration_ms: session.duration_ms ?? null,
    usage: {
      input: numberField(usage.input) ?? 0,
      output: numberField(usage.output) ?? 0,
      cache_read: numberField(usage.cache_read) ?? 0,
    },
    tool: openToolInFlight(items),
    text: null,
  };
}

function syntheticInterruptionText(report: SessionInterruption): string {
  const reason = report.reason ?? "cancelled";
  const state = report.terminal_state ?? "unknown";
  const turns = report.turns ?? 0;
  const duration = fmtDuration(report.duration_ms ?? 0);
  const usage = report.usage ?? {};
  const tool = report.tool;
  const toolText = tool ? `${tool.name ?? "tool"} ${tool.input ?? ""} (returned no result)` : "none (no tool call was in flight)";
  return [
    `The run was interrupted: ${reason}. Terminal state: ${state}.`,
    `Executed: ${turns} model turn${turns === 1 ? "" : "s"}. This run took: ${duration}.`,
    `Cumulative tokens: input ${usage.input ?? 0} / output ${usage.output ?? 0} / cache read ${usage.cache_read ?? 0}.`,
    `Tool running at interruption: ${toolText}.`,
  ].join("\n");
}

function ReportNumbers({ text }: { text: string }) {
  const clean = stripMarkdownLite(text).trim();
  const parts = clean.split(/(\d[\d,]*)/g);
  return (
    <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
      {parts.map((part, index) =>
        /^\d/.test(part) ? (
          <span key={`${index}-${part}`} className="font-mono tabular-nums">
            {part}
          </span>
        ) : (
          <React.Fragment key={`${index}-${part}`}>{part}</React.Fragment>
        ),
      )}
    </p>
  );
}

function InterruptionCard({ report }: { report: SessionInterruption }) {
  const reason = report.reason ?? "cancelled";
  const terminalState = report.terminal_state ?? "unknown";
  const text = (report.text ?? "").trim() || syntheticInterruptionText(report);
  return (
    <div className="my-2 min-w-0 rounded-lg border border-red-500/50 bg-red-500/5 p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <AlertTriangleIcon className="size-4 shrink-0 text-red-600 dark:text-red-400" />
        <span className="text-xs font-semibold text-red-700 dark:text-red-400">The run was interrupted</span>
        <Badge variant="outline" className="border-red-500/40 font-mono text-[10px] text-red-700 dark:text-red-400">
          {reason}
        </Badge>
        <Badge variant="outline" className="border-red-500/30 font-mono text-[10px] text-muted-foreground">
          {terminalState}
        </Badge>
      </div>
      <ReportNumbers text={text} />
      {report.tool && (
        <div className="mt-2 border-t border-red-500/20 pt-2 text-[11px] text-muted-foreground">
          Tool in flight:{" "}
          <span className="font-mono text-foreground/90">
            {report.tool.name ?? "tool"} {report.tool.input ?? ""}
          </span>
        </div>
      )}
    </div>
  );
}

function RoundSummaryCard({ session }: { session: CairnSession }) {
  const summary = session.summary;
  if (!summary) return null;
  if (summary.kind === "interrupted") {
    const report = normalizeInterruption(summary.interruption);
    return report ? <InterruptionCard report={report} /> : null;
  }
  const intents = Array.isArray(summary.intents) ? summary.intents : [];
  const count = summary.count ?? intents.length;
  return (
    <div className="my-2 rounded-lg border bg-muted/30 p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <SparklesIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Round summary</span>
        {session.summary_text && (
          <span className="text-[11px] text-muted-foreground">{session.summary_text}</span>
        )}
      </div>
      {summary.kind === "intents" ? (
        <>
          <p className="text-xs font-medium">
            Proposed {count} intent{count === 1 ? "" : "s"}
          </p>
          {intents.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-relaxed text-foreground/90">
              {intents.map((intent, index) => (
                <li key={`${index}-${intent.description ?? ""}`}>
                  {intent.from?.length ? (
                    <span className="font-mono text-[11px] text-muted-foreground">{intent.from.join(", ")} → </span>
                  ) : null}
                  {intent.description ?? ""}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : summary.kind === "complete" ? (
        <p className="text-xs leading-relaxed">
          Goal satisfied{summary.description ? ` — ${summary.description}` : "."}
        </p>
      ) : summary.kind === "none" ? (
        <p className="text-xs text-muted-foreground">No new intents this round.</p>
      ) : (
        <p className="text-xs text-muted-foreground">{session.summary_text ?? "No summary was recorded."}</p>
      )}
    </div>
  );
}

// ── session row (ported from Artex's SessionItem) ─────────────────────────

function sessionIcon(session: CairnSession) {
  if (session.role === "worker") return statusIcon(session.status);
  if (session.live) return <Loader2Icon className="size-3.5 animate-spin text-blue-500" />;
  return null;
}

function SessionItem({
  session,
  active,
  dimmed,
  onClick,
}: {
  session: CairnSession;
  active: boolean;
  dimmed?: boolean;
  onClick: () => void;
}) {
  const icon = sessionIcon(session);

  return (
    <div
      className={cn(
        "group/session flex w-full items-center rounded-md transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        dimmed && !active && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        title={session.title}
        className="flex min-w-0 w-full flex-1 items-center gap-1 overflow-hidden px-2 py-1.5 text-left text-sm"
      >
        {icon ?? <span className="size-3.5 shrink-0" />}
        <span
          className={cn(
            "block w-0 min-w-0 flex-1 truncate text-sm font-medium",
            dimmed && !active && "text-muted-foreground",
          )}
        >
          {session.title}
        </span>
        {session.live && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
            <span className="size-1 animate-pulse rounded-full bg-blue-500" />
            Live
          </span>
        )}
      </button>
    </div>
  );
}

// ── main view ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 200;
const POLL_MS = 1000;

type SessionState = {
  items: SessionActivity[];
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  reachedStart: boolean;
  earliestSeq: number | null;
  error?: string;
};

function emptyState(): SessionState {
  return {
    items: [],
    loaded: false,
    loading: false,
    loadingMore: false,
    hasMore: false,
    reachedStart: false,
    earliestSeq: null,
  };
}

export function SessionsView({
  projectId,
  onOpenWorkers,
}: {
  projectId: string;
  projectTitle?: string;
  onOpenWorkers?: () => void;
}) {
  const [list, setList] = React.useState<Awaited<ReturnType<typeof fetchSessions>> | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);
  const [connection, setConnection] = React.useState<"live" | "reconnecting">("live");
  const [selectedKey, setSelectedKey] = React.useState("main");
  const [store, setStore] = React.useState<Record<string, SessionState>>({});
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [, setTick] = React.useState(0);
  const sendMode = useChatSendMode();

  const hasListRef = React.useRef(false);
  const refreshListRef = React.useRef<() => void>(() => undefined);
  const refreshActiveRef = React.useRef<() => void>(() => undefined);
  const storeRef = React.useRef(store);
  const activeKeyRef = React.useRef(selectedKey);
  const atBottomRef = React.useRef(true);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  storeRef.current = store;
  activeKeyRef.current = selectedKey;

  const patchStore = React.useCallback((key: string, fn: (state: SessionState) => SessionState) => {
    setStore((prev) => ({ ...prev, [key]: fn(prev[key] ?? emptyState()) }));
  }, []);

  // Re-render once a second so a live elapsed timer keeps ticking.
  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // ── rail poll: GET /projects/{id}/sessions every second ──────────────────
  React.useEffect(() => {
    let alive = true;
    setList(null);
    setListError(null);
    setStore({});
    setSelectedKey("main");
    hasListRef.current = false;

    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await fetchSessions(projectId);
        if (!alive) return;
        hasListRef.current = true;
        setList(next);
        setListError(null);
        setConnection("live");
        setSelectedKey((current) => (next.sessions.some((session) => session.key === current) ? current : "main"));
      } catch (cause) {
        if (!alive) return;
        setConnection("reconnecting");
        if (!hasListRef.current) setListError((cause as Error).message);
      }
    };

    refreshListRef.current = () => void tick();
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectId]);

  const sessions = list?.sessions ?? [];
  const workerSessions = React.useMemo(
    () => orderWorkerSessions(collapseWorkerSessions(sessions)),
    [sessions],
  );
  const displaySessions = React.useMemo(() => {
    const workerKeys = new Set(workerSessions.map((session) => session.key));
    return [...sessions.filter((session) => !workerKeys.has(session.key) && session.role !== "worker"), ...workerSessions];
  }, [sessions, workerSessions]);
  const mainagentSessions = React.useMemo(
    () => displaySessions.filter((session) => session.role === "mainagent"),
    [displaySessions],
  );
  const plannerSessions = React.useMemo(
    () => displaySessions.filter((session) => session.role === "planner"),
    [displaySessions],
  );
  const systemSessions = React.useMemo(
    () => displaySessions.filter((session) => session.role === "system"),
    [displaySessions],
  );
  const grouped = {
    mainagent: mainagentSessions,
    planner: plannerSessions,
    system: systemSessions,
    worker: workerSessions,
  };
  const active =
    displaySessions.find((session) => session.key === selectedKey) ??
    displaySessions.find((session) => session.key === "main") ??
    null;
  const activeKey = active?.key ?? "main";
  const activeKeys = React.useMemo(
    () => (active?.merged_keys?.length ? active.merged_keys : [activeKey]),
    [active?.merged_keys, activeKey],
  );
  const activeKeysKey = activeKeys.join("|");
  const activeState = store[activeKey];
  const activeItems = activeState?.items ?? [];
  const isMain = active?.role === "mainagent";
  const isWorker = active?.role === "worker";
  const isPlanner = active?.role === "planner";

  // ── active session poll: latest page every second, older pages on scroll ──
  React.useEffect(() => {
    if (!projectId) return;
    let alive = true;
    let inFlight = false;
    const key = activeKey;

    const loadLatest = async (initial: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (initial) {
        patchStore(key, (state) => ({ ...state, loading: !state.loaded, error: undefined }));
      }
      try {
        const pages = await Promise.all(
          activeKeys.map((sessionKey) => fetchSessionActivities(projectId, sessionKey, { limit: PAGE_SIZE })),
        );
        if (!alive) return;
        // Old backends return one transcript per execute/conclude run. Offset
        // their per-run local seqs so merging both phases cannot overwrite rows.
        const incoming = pages.flatMap((page, index) =>
          page.items.map((item) => (index === 0 ? item : { ...item, seq: item.seq + index * 1_000_000_000 })),
        );
        const pageHasMore = pages.some((page) => page.has_more);
        patchStore(key, (state) => {
          const items = mergeActivities(state.items, incoming);
          return {
            ...state,
            items,
            loaded: true,
            loading: false,
            error: undefined,
            hasMore: state.reachedStart ? false : pageHasMore || state.hasMore,
            reachedStart: state.reachedStart || !pageHasMore,
            earliestSeq: items[0]?.seq ?? null,
          };
        });
      } catch (cause) {
        if (!alive) return;
        patchStore(key, (state) => ({
          ...state,
          loading: false,
          loaded: true,
          error: (cause as Error).message,
        }));
      } finally {
        inFlight = false;
      }
    };

    refreshActiveRef.current = () => void loadLatest(true);
    void loadLatest(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadLatest(false);
    }, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") void loadLatest(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: activeKeysKey tracks merged transcript membership.
  }, [projectId, activeKey, activeKeysKey, patchStore]);

  // ── reverse pagination (load earlier history when scrolled near the top) ──
  const loadEarlier = React.useCallback(async () => {
    const key = activeKeyRef.current;
    const state = storeRef.current[key];
    if (!state || state.loadingMore || !state.hasMore || state.earliestSeq == null) return;
    const viewport = contentRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    patchStore(key, (current) => ({ ...current, loadingMore: true }));
    try {
      const page = await fetchSessionActivities(projectId, key, {
        before: state.earliestSeq,
        limit: PAGE_SIZE,
      });
      patchStore(key, (current) => {
        const items = mergeActivities(current.items, page.items);
        return {
          ...current,
          items,
          loadingMore: false,
          hasMore: page.has_more,
          reachedStart: !page.has_more,
          earliestSeq: items[0]?.seq ?? null,
        };
      });
      requestAnimationFrame(() => {
        if (!viewport) return;
        viewport.scrollTop = previousTop + (viewport.scrollHeight - previousHeight);
      });
    } catch {
      patchStore(key, (current) => ({ ...current, loadingMore: false }));
    }
  }, [projectId, patchStore]);

  // Bind the scroll listener to the transcript viewport.
  React.useEffect(() => {
    const viewport = contentRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    if (!viewport) return;
    const onScroll = () => {
      atBottomRef.current = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 60;
      if (viewport.scrollTop <= 80) void loadEarlier();
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [activeKey, loadEarlier]);

  // Open/switch a session -> jump to the latest (bottom).
  React.useLayoutEffect(() => {
    const viewport = contentRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      atBottomRef.current = true;
    }
  }, [activeKey]);

  // New activity -> stick to the bottom only when the reader is already pinned there.
  const activityLength = activeItems.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: activity growth intentionally drives live-edge scrolling.
  React.useLayoutEffect(() => {
    if (!atBottomRef.current) return;
    const viewport = contentRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [activityLength]);

  // Detail expansion / markdown can grow after render; re-pin while at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe when the active session changes.
  React.useEffect(() => {
    const element = contentRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!atBottomRef.current) return;
      const viewport = contentRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeKey]);

  const transcriptActivity = React.useMemo(() => buildTranscript(activeItems, active), [activeItems, active]);
  const detailBySeq = React.useMemo(() => {
    const map = new Map<number, string>();
    for (const row of transcriptActivity) {
      map.set(row.seq, row.detail ?? row.summary ?? "");
    }
    return map;
  }, [transcriptActivity]);
  const fetchDetail = React.useCallback((seq: number) => Promise.resolve(detailBySeq.get(seq) ?? ""), [detailBySeq]);

  const tokens = sessionTokens(active);
  const tokenAny = tokens.input + tokens.cache_read + tokens.output > 0;
  const runDuration = elapsedMs(active, activeItems, Date.now());
  const queued = Boolean(active?.queued);
  const interrupted = Boolean(active?.interrupted || active?.summary?.kind === "interrupted");
  const interruption = React.useMemo(() => interruptionFor(active, activeItems), [active, activeItems]);
  const mainBusy = isMain && (sending || active?.status === "running" || Boolean(active?.live));
  const tail = activeItems[activeItems.length - 1];
  const tailStreamingText =
    tail?.kind === "message" &&
    tail.role === "assistant" &&
    (tail.status === "streaming" || tail.status === "running") &&
    Boolean(tail.content?.trim());
  const showThinking = (Boolean(active?.live) || (isMain && sending)) && !tailStreamingText;
  const showLoader = !activeState || (activeState.loading && !activeState.loaded);

  function send() {
    const text = input.trim();
    if (!text || sending || mainBusy) return;
    setInput("");
    setSendError(null);
    setSending(true);
    void sendMainMessage(projectId, text)
      .then(() => {
        refreshListRef.current();
        refreshActiveRef.current();
      })
      .catch((cause) => {
        setInput(text);
        setSendError((cause as Error).message);
        toast.error("Send failed", { description: (cause as Error).message });
      })
      .finally(() => setSending(false));
  }

  function stop() {
    if (stopping) return;
    setStopping(true);
    void stopMainTurn(projectId)
      .then((result) => {
        if (!result) {
          toast.info("There is no conversation to stop yet.");
          return;
        }
        toast.info(result.reconciled ? "The turn had already ended" : "Stopping the turn…");
        refreshListRef.current();
        refreshActiveRef.current();
      })
      .catch((cause) => {
        toast.error("Could not stop the turn", { description: (cause as Error).message });
      })
      .finally(() => setStopping(false));
  }

  const taskTotal = list?.task_total;
  const title = active?.title ?? "Conversation";

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "grid h-[calc(100svh-10rem)] min-h-0 grid-cols-1 gap-4",
          "grid-rows-[auto_minmax(0,1fr)]",
          "lg:h-[calc(100svh-13rem)] lg:grid-cols-[292px_1fr] lg:grid-rows-[minmax(0,1fr)]",
        )}
      >
        {/* Left: session list (292px on desktop) */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
          <div className="border-b px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1 text-xs font-medium text-muted-foreground">
                <ChevronDownIcon className="size-3.5 shrink-0 lg:hidden" />
                <span className="shrink-0">Conversations</span>
              </div>
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-[10px]",
                  connection === "live" ? "text-emerald-500" : "text-amber-500",
                )}
                title={
                  connection === "live"
                    ? "The session API is polling normally"
                    : "The session poll failed; retrying every second (history remains visible)"
                }
              >
                {connection === "live" ? (
                  <>
                    <span className="size-1 animate-pulse rounded-full bg-emerald-500" />
                    Live
                  </>
                ) : (
                  <>
                    <WifiOffIcon className="size-3" />
                    Reconnecting
                  </>
                )}
              </span>
            </div>
            {taskTotal && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span>Task total</span>
                    <span>·</span>
                    <TokenMetrics input={taskTotal.input} cache={taskTotal.cache_read} output={taskTotal.output} />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  input {taskTotal.input.toLocaleString()} - output {taskTotal.output.toLocaleString()} - cache reads{" "}
                  {taskTotal.cache_read.toLocaleString()}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          <ScrollArea id="session-list-panel" type="auto" className="min-h-0 flex-1">
            <div className="flex w-full flex-col gap-3 p-2">
              {(["mainagent", "planner", "system", "worker"] as const).map((role) => {
                const items = grouped[role];
                const Meta = roleMeta[role];
                return (
                  <div key={role} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
                      <Meta.icon className="size-3.5" />
                      {Meta.label}
                      {role === "worker" && items.length > 0 && (
                        <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
                          {items.length}
                        </span>
                      )}
                    </div>
                    {items.map((session) => (
                      <SessionItem
                        key={session.key}
                        session={session}
                        active={session.key === activeKey}
                        dimmed={Boolean(session.queued)}
                        onClick={() => setSelectedKey(session.key)}
                      />
                    ))}
                    {role === "worker" && items.length === 0 && list && (
                      <div className="px-2 py-1 text-[11px] leading-relaxed text-muted-foreground">
                        {list.sessions.some((s) => s.role === "planner" && s.live)
                          ? "The planner is defining intents; workers will appear here as it opens them."
                          : list.project_status === "completed"
                            ? "This project is complete; no worker transcripts were recorded."
                            : "No worker runs yet. Queued intents appear here as soon as they are proposed."}
                      </div>
                    )}
                    {role !== "worker" && items.length === 0 && list && (
                      <div className="px-2 py-1 text-[11px] text-muted-foreground">Not recorded yet.</div>
                    )}
                  </div>
                );
              })}
              {!list && !listError && (
                <div className="flex flex-col gap-2 px-1 py-2">
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-4/5" />
                  <Skeleton className="h-5 w-3/4" />
                </div>
              )}
              {listError && !list && (
                <div className="px-2 py-2 text-[11px] text-destructive">
                  Sessions API: {listError}
                  <Button size="xs" variant="ghost" className="mt-1 w-fit" onClick={() => refreshListRef.current()}>
                    <RefreshCwIcon data-icon="inline-start" />
                    Retry
                  </Button>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right: transcript */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 sm:px-4 sm:py-2.5">
            <span className="min-w-0 truncate text-sm font-medium" title={active?.title ?? undefined}>
              {title}
            </span>
            {active?.model && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="max-w-32 shrink-0 font-normal">
                    <span className="truncate">{active.model}</span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="bottom">{active.model}</TooltipContent>
              </Tooltip>
            )}
            {isWorker && (
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                {active?.intent_id ?? active?.task ?? "worker"}
              </Badge>
            )}
            {queued ? (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                <ClockIcon className="size-3" />
                Queued
              </span>
            ) : interrupted ? (
              <span
                className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                title={active?.interrupt_reason ?? active?.summary?.interruption?.reason ?? "interrupted"}
              >
                <AlertTriangleIcon className="size-3" />
                Interrupted
              </span>
            ) : active?.live ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                  connection === "live"
                    ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                    : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                )}
              >
                <span
                  className={cn(
                    "size-1 animate-pulse rounded-full",
                    connection === "live" ? "bg-blue-500" : "bg-amber-500",
                  )}
                />
                {connection === "live" ? "Live" : "Reconnecting"}
              </span>
            ) : isWorker && active?.status === "success" ? (
              <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                <CircleCheckIcon className="size-3" />
                Completed
              </span>
            ) : null}
            {activeState?.hasMore && (
              <span className="text-[10px] text-muted-foreground" title="Scroll up to load earlier history">
                ^ Earlier history
              </span>
            )}
            <div className="ml-auto flex min-w-0 max-w-full items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground max-sm:w-full max-sm:flex-wrap">
              {tokenAny && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex min-w-0 items-center">
                      <TokenMetrics
                        input={tokens.input}
                        cache={tokens.cache_read}
                        output={tokens.output}
                        labels="short"
                        className="sm:hidden"
                      />
                      <TokenMetrics
                        input={tokens.input}
                        cache={tokens.cache_read}
                        output={tokens.output}
                        labels="long"
                        className="max-sm:hidden"
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    input {tokens.input.toLocaleString()} - output {tokens.output.toLocaleString()} - cache reads{" "}
                    {tokens.cache_read.toLocaleString()}
                  </TooltipContent>
                </Tooltip>
              )}
              {runDuration != null && (
                <span className="inline-flex items-center gap-1" title="Run time (first step -> last step)">
                  <ClockIcon className="size-3" />
                  {fmtDuration(runDuration)}
                </span>
              )}
              {isMain && <span>Interactive</span>}
            </div>
          </div>

          <ScrollArea type="auto" className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
            <div className="min-w-0 max-w-full p-4" ref={contentRef}>
              {activeState?.loadingMore && (
                <div className="flex items-center justify-center gap-2 pb-2 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Loading earlier history...
                </div>
              )}
              {showLoader ? (
                <div className="flex items-center gap-2 pl-9 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Loading the activity stream...
                </div>
              ) : activeState?.error && !transcriptActivity.length ? (
                <div className="flex items-center gap-2 pl-9 text-xs text-red-500">
                  <CircleXIcon className="size-3.5" />
                  Load failed: {activeState.error}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => refreshActiveRef.current()}
                  >
                    Retry
                  </Button>
                </div>
              ) : queued ? (
                <div className="flex items-start gap-2 pl-2 text-xs text-muted-foreground">
                  <ClockIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>Queued — waiting for a free worker slot.</span>
                </div>
              ) : transcriptActivity.length ? (
                <>
                  {activeState?.error && (
                    <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                      <WifiOffIcon className="size-3.5 shrink-0" />
                      Reconnecting — showing the last recorded activity.
                    </div>
                  )}
                  <Transcript
                    activity={transcriptActivity}
                    taskId={projectId}
                    chat={isMain}
                    fetchDetail={fetchDetail}
                  />
                  {showThinking && (
                    <div className="flex items-center gap-2 pl-2 pt-1 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3.5 animate-spin" />
                      Thinking…
                    </div>
                  )}
                  {isWorker && interruption && <InterruptionCard report={interruption} />}
                  {isPlanner &&
                    (active?.summary ? (
                      <RoundSummaryCard session={active} />
                    ) : interruption ? (
                      <InterruptionCard report={interruption} />
                    ) : null)}
                </>
              ) : (
                <div className="pl-9 text-xs text-muted-foreground">
                  {isMain
                    ? "No conversation yet. Message the main agent below to steer the exploration or step into the flow."
                    : isPlanner
                      ? active?.live
                        ? "The planner is running; its first activity will appear here."
                        : "No planner run has been recorded yet."
                      : isWorker
                        ? "No transcript has been recorded for this worker yet."
                        : "No activity recorded."}
                </div>
              )}
            </div>
          </ScrollArea>

          {isMain ? (
            <div className="border-t p-3">
              {sendError && <div className="mb-2 text-[11px] text-destructive">{sendError}</div>}
              <InputGroup className="min-h-9 has-disabled:opacity-100">
                <InputGroupTextarea
                  rows={1}
                  aria-label="Message the main agent"
                  placeholder={
                    mainBusy
                      ? "The main agent is running; stop it before sending another message..."
                      : "Message the main agent; use @ to reference a finding, an asset and so on..."
                  }
                  value={input}
                  disabled={sending}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (!shouldSubmitOnKey(event, sendMode)) return;
                    event.preventDefault();
                    send();
                  }}
                  className="max-h-36 min-h-9 overflow-y-auto"
                />
                <InputGroupAddon align="block-end">
                  <span className="px-1 text-[10px] text-muted-foreground">
                    {mainBusy ? "Main agent is running" : "Enter to send · Shift+Enter for a new line"}
                  </span>
                  {mainBusy ? (
                    <InputGroupButton
                      className="ml-auto"
                      size="icon-xs"
                      variant="destructive"
                      onClick={stop}
                      disabled={stopping}
                      title="Stop the current execution"
                      aria-label="Stop the current execution"
                    >
                      {stopping ? <Loader2Icon className="animate-spin" /> : <SquareIcon />}
                    </InputGroupButton>
                  ) : (
                    <InputGroupButton
                      className="ml-auto"
                      size="icon-xs"
                      variant="default"
                      onClick={send}
                      disabled={!input.trim() || sending}
                      title="Send the message"
                      aria-label="Send the message"
                    >
                      {sending ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
                    </InputGroupButton>
                  )}
                </InputGroupAddon>
              </InputGroup>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-[11px] text-muted-foreground">
              <span>
                {queued
                  ? "No transcript yet — the worker starts when a slot opens."
                  : isWorker
                    ? `Read-only worker execution history · ${active?.status ?? "unknown"} · polled every 1s`
                    : "Read-only audit history · polled every 1s"}
              </span>
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
