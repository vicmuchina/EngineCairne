"use client";

import * as React from "react";

import { BrainIcon, ChevronDownIcon, Loader2Icon, MessageSquareIcon, RadioTowerIcon, WrenchIcon } from "lucide-react";

import { Markdown } from "@/components/markdown";
import { StatusBadge } from "@/components/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import type { ChatActivity } from "@/lib/cairn-api";
import { formatNumber, formatRelative } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

export interface SteerNotice {
  id: string;
  message: string;
  at: number;
}

interface ToolPair {
  call: ChatActivity;
  result?: ChatActivity;
}

interface RunGroup {
  key: string;
  seq: number;
  user?: ChatActivity;
  final?: ChatActivity;
  thinking: ChatActivity[];
  tools: ToolPair[];
  steering: ChatActivity[];
  usage?: ChatActivity;
  errors: ChatActivity[];
  compaction: ChatActivity[];
}

const LIVE_STATUSES = new Set(["running", "streaming", "pending", "queued"]);
const MEANINGFUL = new Set([
  "message",
  "thinking",
  "tool_call",
  "tool_result",
  "usage",
  "steering",
  "error",
  "compaction",
]);

function isMeaningful(activity: ChatActivity): boolean {
  if (!MEANINGFUL.has(activity.kind)) return false;
  if (activity.kind === "message") {
    // Keep an empty assistant message when the turn stopped/failed so the timeline
    // can render the terminal marker. An empty running assistant row is also kept
    // (AssistantText renders nothing for it); the single ThinkingIndicator below
    // represents the in-flight state, avoiding duplicate "Thinking…" bubbles.
    if (activity.role === "user") return Boolean(activity.content?.trim());
    return activity.role === "assistant";
  }
  return true;
}

function parseUsage(content: string | null | undefined) {
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    return {
      input: typeof value.input === "number" ? value.input : undefined,
      output: typeof value.output === "number" ? value.output : undefined,
      cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : undefined,
      totalTokens: typeof value.totalTokens === "number" ? value.totalTokens : undefined,
    };
  } catch {
    return null;
  }
}

function toolPairs(steps: ChatActivity[]): ToolPair[] {
  const calls = steps.filter((step) => step.kind === "tool_call");
  const results = steps.filter((step) => step.kind === "tool_result");
  const used = new Set<number>();
  const pairs = calls.map((call) => {
    const result = results.find((entry) => entry.tool_call_id && entry.tool_call_id === call.tool_call_id);
    if (result) used.add(result.id);
    return { call, result };
  });
  for (const result of results) {
    if (!used.has(result.id)) pairs.push({ call: result, result });
  }
  return pairs;
}

function buildRuns(activities: ChatActivity[]): RunGroup[] {
  const groups = new Map<string, { seq: number; steps: ChatActivity[] }>();
  for (const activity of activities) {
    if (!isMeaningful(activity)) continue;
    const key = activity.run_id ?? `message-${activity.message_id ?? activity.seq}`;
    const group = groups.get(key) ?? { seq: Number.POSITIVE_INFINITY, steps: [] };
    group.seq = Math.min(group.seq, activity.seq);
    group.steps.push(activity);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.seq - b.seq)
    .map(([key, group]) => {
      const steps = [...group.steps].sort((a, b) => a.seq - b.seq);
      const users = steps.filter((step) => step.kind === "message" && step.role === "user");
      const assistants = steps.filter((step) => step.kind === "message" && step.role === "assistant");
      const finals = assistants.filter((step) => Boolean(step.content?.trim()));
      return {
        key,
        seq: group.seq,
        user: users[users.length - 1],
        final: finals[finals.length - 1] ?? assistants[assistants.length - 1],
        thinking: steps.filter((step) => step.kind === "thinking"),
        tools: toolPairs(steps),
        steering: steps.filter((step) => step.kind === "steering"),
        usage: [...steps].reverse().find((step) => step.kind === "usage"),
        errors: steps.filter((step) => step.kind === "error"),
        compaction: steps.filter((step) => step.kind === "compaction"),
      };
    });
}

function ReasoningBlock({ activity }: { activity: ChatActivity }) {
  const streaming = activity.status === "streaming" || activity.status === "running";
  const [open, setOpen] = React.useState(streaming);
  React.useEffect(() => {
    setOpen(streaming);
  }, [streaming]);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="rounded-lg border bg-muted/10"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
        <BrainIcon className="size-3.5" />
        Reasoning
        <StatusBadge domain="cairnFeed" value={activity.status} dot className="px-1.5 py-0 text-[11px]" />
        <ChevronDownIcon className="ml-auto size-3.5 transition-transform [[open]>&]:rotate-180" />
      </summary>
      <pre className="max-h-40 overflow-auto border-t px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {activity.content ?? ""}
      </pre>
    </details>
  );
}

function ToolCard({ pair }: { pair: ToolPair }) {
  const { call, result } = pair;
  const output = call.tool_output ?? result?.tool_output ?? result?.content;
  const status = result?.status ?? call.status;
  const running = LIVE_STATUSES.has(status) && !output;
  const name = call.tool_name ?? result?.tool_name ?? "tool";
  return (
    <div className="rounded-lg border bg-muted/20">
      <div className="flex flex-wrap items-center gap-2 border-b px-2.5 py-1.5">
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-[11px] font-medium">{name}</span>
        <StatusBadge domain="cairnFeed" value={status} dot className="px-1.5 py-0 text-[11px]" />
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">#{call.seq}</span>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        {call.tool_input && (
          <div>
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Input</div>
            <pre className="max-h-40 overflow-auto rounded border bg-background/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
              {call.tool_input}
            </pre>
          </div>
        )}
        {output ? (
          <div>
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Output</div>
            <pre className="max-h-40 overflow-auto rounded border bg-background/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
              {output.length > 5000 ? `${output.slice(0, 5000)}…` : output}
            </pre>
          </div>
        ) : running ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> Running…
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">No output recorded.</div>
        )}
      </div>
    </div>
  );
}

function SteerLine({ activity }: { activity: ChatActivity }) {
  return (
    <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 px-2.5 py-2">
      <div className="flex items-center gap-2 text-[11px] font-medium text-violet-600 dark:text-violet-400">
        <RadioTowerIcon className="size-3.5" />
        Steer
        <StatusBadge domain="cairnFeed" value={activity.status} dot className="ml-auto px-1.5 py-0 text-[11px]" />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
        {activity.content ?? "Steering message delivered."}
      </p>
    </div>
  );
}

function UsageLine({ activity }: { activity: ChatActivity }) {
  const usage = parseUsage(activity.content);
  if (!usage) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      <span>Last call</span>
      <span>input {formatNumber(usage.input ?? 0)}</span>
      <span>output {formatNumber(usage.output ?? 0)}</span>
      {usage.cacheRead ? <span>cache {formatNumber(usage.cacheRead)}</span> : null}
      {usage.totalTokens ? <span>total {formatNumber(usage.totalTokens)}</span> : null}
    </div>
  );
}

function AssistantText({ activity }: { activity: ChatActivity }) {
  const content = activity.content?.trim() ?? "";
  const running = activity.status === "running" || activity.status === "streaming";
  const stopped = activity.status === "stopped";
  const failed = activity.status === "error";

  // The bottom ThinkingIndicator is the only in-flight indicator. An empty
  // running assistant message must not add a second "Waiting/Thinking" bubble.
  if (running && !content) return null;

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn("rounded-xl border px-3 py-2", failed ? "border-destructive/30 bg-destructive/5" : "bg-muted/40")}
      >
        {content ? (
          <Markdown text={content} />
        ) : (
          <div className="text-xs text-muted-foreground">
            {failed
              ? (activity.error ?? "The turn failed.")
              : stopped
                ? "The turn was stopped before any content was returned."
                : "No content returned."}
          </div>
        )}
        {failed && content && (
          <div className="mt-1 text-[11px] text-destructive">{activity.error ?? "The turn failed."}</div>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{formatRelative(activity.created_at)}</span>
        {running && content && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            Streaming
          </Badge>
        )}
        {stopped && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            Stopped
          </Badge>
        )}
        {failed && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-destructive">
            Error
          </Badge>
        )}
        {activity.tokens_out ? <span>{formatNumber(activity.tokens_out)} out</span> : null}
      </div>
    </div>
  );
}

function ThinkingIndicator({ since }: { since: number }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div className="flex items-start gap-2" aria-live="polite">
      <Avatar className="mt-0.5 size-7 rounded-lg">
        <AvatarFallback className="rounded-lg text-[11px]">C</AvatarFallback>
      </Avatar>
      <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" />
        Thinking… <span className="text-[11px] tabular-nums">{seconds}s</span>
      </div>
    </div>
  );
}

/**
 * Live Artex-style chat timeline: user turns, reasoning folds, tool_use with
 * paired tool_result output, assistant text, usage/compaction/error markers and
 * steering notices. Built from the pollable chat activities, not just the
 * final message list.
 */
export function CairnChatTimeline({
  activities,
  pendingUser,
  thinking,
  thinkingSince,
  steerNotices,
}: {
  activities: readonly ChatActivity[];
  pendingUser: string | null;
  thinking: boolean;
  thinkingSince: number | null;
  steerNotices: readonly SteerNotice[];
}) {
  const runs = React.useMemo(() => buildRuns([...activities]), [activities]);
  const aggregate = React.useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let totalTokens = 0;
    let calls = 0;
    for (const activity of activities) {
      if (activity.kind !== "usage") continue;
      const usage = parseUsage(activity.content);
      if (!usage) continue;
      calls += 1;
      input += usage.input ?? 0;
      output += usage.output ?? 0;
      cacheRead += usage.cacheRead ?? 0;
      totalTokens += usage.totalTokens ?? 0;
    }
    return calls > 0 ? { input, output, cacheRead, totalTokens, calls } : null;
  }, [activities]);
  // A streaming assistant message is already the live indicator. Keep the
  // bottom spinner only while there is no visible streamed text, so a turn
  // never shows two "Thinking…" indicators at once.
  const streamingText = activities.some(
    (activity) =>
      activity.kind === "message" &&
      activity.role === "assistant" &&
      LIVE_STATUSES.has(activity.status) &&
      Boolean(activity.content?.trim()),
  );
  const showThinkingIndicator = thinking && !streamingText;
  const pendingVisible =
    Boolean(pendingUser) &&
    !activities.some(
      (activity) => activity.kind === "message" && activity.role === "user" && activity.content === pendingUser,
    );

  return (
    <div className="flex flex-col gap-5">
      {runs.map((run) => (
        <div key={run.key} className="flex flex-col gap-3">
          {run.user?.content && (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>You</span>
                <span>·</span>
                <span>{formatRelative(run.user.created_at)}</span>
              </div>
              <Bubble align="end" variant="default" className="max-w-[85%]">
                <BubbleContent className="whitespace-pre-wrap text-sm">{run.user.content}</BubbleContent>
              </Bubble>
            </div>
          )}

          {(run.final ||
            run.thinking.length > 0 ||
            run.tools.length > 0 ||
            run.steering.length > 0 ||
            run.usage ||
            run.errors.length > 0 ||
            run.compaction.length > 0) && (
            <div className="flex items-start gap-2">
              <Avatar className="mt-0.5 size-7 rounded-lg">
                <AvatarFallback className="rounded-lg text-[11px]">C</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
                    Cairn
                  </Badge>
                  {run.final && (
                    <span className="text-[11px] text-muted-foreground">{formatRelative(run.final.created_at)}</span>
                  )}
                </div>

                {run.thinking.map((activity) => (
                  <ReasoningBlock key={activity.id} activity={activity} />
                ))}
                {run.tools.map((pair) => (
                  <ToolCard key={`tool-${pair.call.id}`} pair={pair} />
                ))}
                {run.steering.map((activity) => (
                  <SteerLine key={`steer-${activity.id}`} activity={activity} />
                ))}
                {run.final && <AssistantText activity={run.final} />}
                {run.usage && <UsageLine activity={run.usage} />}
                {run.errors.map((activity) => (
                  <div
                    key={`error-${activity.id}`}
                    className="rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive"
                  >
                    {activity.error ?? activity.content ?? "Turn error"}
                  </div>
                ))}
                {run.compaction.map((activity) => (
                  <div key={`compaction-${activity.id}`} className="text-[11px] text-muted-foreground">
                    Context compacted{activity.content ? `: ${activity.content}` : "."}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {pendingVisible && pendingUser && (
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>You</span>
            <span>·</span>
            <span>Sending…</span>
          </div>
          <Bubble align="end" variant="default" className="max-w-[85%]">
            <BubbleContent className="whitespace-pre-wrap text-sm">{pendingUser}</BubbleContent>
          </Bubble>
        </div>
      )}

      {aggregate && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">Conversation usage</span>
          <span>input {formatNumber(aggregate.input)}</span>
          <span>output {formatNumber(aggregate.output)}</span>
          {aggregate.cacheRead ? <span>cache {formatNumber(aggregate.cacheRead)}</span> : null}
          {aggregate.totalTokens ? <span>total {formatNumber(aggregate.totalTokens)}</span> : null}
          <span className="text-muted-foreground/70">
            {formatNumber(aggregate.calls)} usage {aggregate.calls === 1 ? "call" : "calls"}
          </span>
        </div>
      )}

      {showThinkingIndicator && <ThinkingIndicator since={thinkingSince ?? Date.now()} />}

      {steerNotices.map((notice) => (
        <div
          key={notice.id}
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive"
        >
          <div className="flex items-center gap-1.5 font-medium">
            <RadioTowerIcon className="size-3.5" />
            Steer not accepted
          </div>
          <div className="mt-0.5 break-words whitespace-pre-wrap">{notice.message}</div>
        </div>
      ))}

      {runs.length === 0 && !pendingVisible && !thinking && steerNotices.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <MessageSquareIcon className="size-5 text-muted-foreground" />
          </div>
          <div>
            <div className="text-sm font-medium">Ask the main agent about this project</div>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Reasoning, tool calls and token usage stream here while the turn runs.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
