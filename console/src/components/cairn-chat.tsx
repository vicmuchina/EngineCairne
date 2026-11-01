"use client";

import * as React from "react";

import Link from "next/link";

import {
  ArrowUpIcon,
  AtSignIcon,
  BrainIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PlusIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { toast } from "sonner";

import { CairnChatTimeline, type SteerNotice } from "@/components/cairn-chat-timeline";
import { StatusBadge } from "@/components/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CairnApiError, type ChatActivity, type ChatConversation, type ChatMessage, cairn } from "@/lib/cairn-api";
import { formatNumber, formatRelative, oneLine } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

type Pane = "transcript" | "activity";

type MentionItem = { id: string; text: string };

interface UsageSummary {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

function parseUsage(content: string | null | undefined): UsageSummary | null {
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    return {
      input: typeof value.input === "number" ? value.input : undefined,
      output: typeof value.output === "number" ? value.output : undefined,
      cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : undefined,
      cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : undefined,
      totalTokens: typeof value.totalTokens === "number" ? value.totalTokens : undefined,
    };
  } catch {
    return null;
  }
}

const TRACE_SKIP = new Set([
  "session",
  "session_entry",
  "raw",
  "event",
  "session_info",
  "thinking_level",
  "turn_start",
  "turn_end",
  "agent_start",
  "agent_end",
  "agent_settled",
  "queue",
  "notify",
]);

function traceMeta(activity: ChatActivity): { label: string; icon: React.ElementType; className: string } {
  switch (activity.kind) {
    case "tool_call":
      return { label: "Tool", icon: WrenchIcon, className: "text-cyan-600 dark:text-cyan-400" };
    case "thinking":
      return { label: "Reasoning", icon: BrainIcon, className: "text-violet-600 dark:text-violet-400" };
    case "message":
      return { label: "Message", icon: MessageSquareIcon, className: "text-blue-600 dark:text-blue-400" };
    case "usage":
      return { label: "Usage", icon: TerminalIcon, className: "text-muted-foreground" };
    case "error":
      return { label: "Error", icon: TerminalIcon, className: "text-red-600 dark:text-red-400" };
    case "compaction":
      return { label: "Compaction", icon: BrainIcon, className: "text-teal-600 dark:text-teal-400" };
    default:
      return {
        label: activity.kind.replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
        icon: TerminalIcon,
        className: "text-muted-foreground",
      };
  }
}

/**
 * Legacy conversations created before the activity recorder have messages but no
 * activities. Convert them into the same timeline rows so there is exactly one
 * transcript renderer (and one in-flight indicator) in both cases.
 */
function messagesToActivities(messages: readonly ChatMessage[]): ChatActivity[] {
  let runId = "legacy-0";
  const out: ChatActivity[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "user") runId = message.run_id ?? `legacy-${message.id}`;
    out.push({
      id: -message.id,
      conversation_id: 0,
      message_id: message.id,
      run_id: message.run_id ?? runId,
      seq: message.seq,
      kind: "message",
      role: message.role,
      content: message.content,
      status: message.status,
      error: message.error,
      tokens_in: message.tokens_in,
      tokens_out: message.tokens_out,
      created_at: message.created_at,
    });
  }
  return out;
}

export function CairnChat({
  projectId,
  projectTitle,
  compact = false,
  initialConversationId,
}: {
  projectId: string;
  projectTitle?: string;
  compact?: boolean;
  initialConversationId?: number;
}) {
  const [conversations, setConversations] = React.useState<ChatConversation[]>([]);
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<number | null>(initialConversationId ?? null);
  const selectedRef = React.useRef<number | null>(selectedId);

  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [activities, setActivities] = React.useState<ChatActivity[]>([]);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [threadError, setThreadError] = React.useState<string | null>(null);
  const [pane, setPane] = React.useState<Pane>("transcript");

  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [thinkingSince, setThinkingSince] = React.useState<number | null>(null);
  const [pendingUser, setPendingUser] = React.useState<string | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [steerText, setSteerText] = React.useState("");
  const [steering, setSteering] = React.useState(false);
  const [steerNotices, setSteerNotices] = React.useState<SteerNotice[]>([]);
  const [mentionOpen, setMentionOpen] = React.useState(false);
  const [mentionItems, setMentionItems] = React.useState<MentionItem[]>([]);
  const [deleteTarget, setDeleteTarget] = React.useState<ChatConversation | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const abortRef = React.useRef<AbortController | null>(null);
  const activitySeqRef = React.useRef(0);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef(true);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    selectedRef.current = selectedId;
    setSteerNotices([]);
    // A newly selected thread opens at its latest tail, and is then pinned
    // there until the user scrolls away from the bottom.
    stickRef.current = true;
  }, [selectedId]);

  const active = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  const thinking = sending || active?.status === "running";
  const latestAssistant = React.useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index];
    }
    return null;
  }, [messages]);
  // The conversation row goes idle when a turn is stopped; the assistant row is
  // the authoritative terminal state, so surface Stopped/Error instead of Idle.
  const displayStatus = sending
    ? "running"
    : active?.status === "error"
      ? "error"
      : latestAssistant?.status === "stopped"
        ? "stopped"
        : (active?.status ?? "idle");
  const timelineActivities = React.useMemo(
    () => (activities.length > 0 ? activities : messagesToActivities(messages)),
    [activities, messages],
  );

  // Load the project conversation list once per project.
  React.useEffect(() => {
    let alive = true;
    setListLoading(true);
    setListError(null);
    cairn
      .listConversations(projectId)
      .then(({ items }) => {
        if (!alive) return;
        setConversations(items);
        setSelectedId((current) => {
          if (current && items.some((item) => item.id === current)) return current;
          if (initialConversationId && items.some((item) => item.id === initialConversationId)) {
            return initialConversationId;
          }
          return items[0]?.id ?? null;
        });
      })
      .catch((cause: Error) => {
        if (alive) setListError(cause.message);
      })
      .finally(() => {
        if (alive) setListLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, initialConversationId]);

  // Referenceable facts/intents for the @ affordance. If this fails the @ button
  // simply does not render (no dead affordance).
  React.useEffect(() => {
    let alive = true;
    cairn
      .getProject(projectId)
      .then((detail) => {
        if (!alive) return;
        const facts = detail.facts
          .filter((fact) => fact.id !== "origin" && fact.id !== "goal")
          .map((fact) => ({ id: `fact:${fact.id}`, text: oneLine(fact.description) }));
        const intents = detail.intents.map((intent) => ({
          id: `intent:${intent.id}`,
          text: oneLine(intent.description),
        }));
        setMentionItems([...facts, ...intents]);
      })
      .catch(() => {
        if (alive) setMentionItems([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const refreshConversations = React.useCallback(
    async (selectFirst = false) => {
      try {
        const { items } = await cairn.listConversations(projectId);
        setConversations(items);
        setSelectedId((current) => {
          if (current && items.some((item) => item.id === current)) return current;
          return selectFirst ? (items[0]?.id ?? null) : current;
        });
      } catch {
        /* transient poll errors keep the current list */
      }
    },
    [projectId],
  );

  const refreshMessages = React.useCallback(async (conversationId: number) => {
    try {
      const { items } = await cairn.listMessages(conversationId);
      if (selectedRef.current !== conversationId) return;
      setMessages(items);
      setThreadError(null);
    } catch (cause) {
      if (selectedRef.current === conversationId) setThreadError((cause as Error).message);
    }
  }, []);

  const refreshActivities = React.useCallback(async (conversationId: number, afterSeq = activitySeqRef.current) => {
    try {
      const list = await cairn.listChatActivities(conversationId, afterSeq);
      if (selectedRef.current !== conversationId) return;
      if (list.items.length > 0) {
        setActivities((current) => {
          const byId = new Map(current.map((activity) => [activity.id, activity]));
          for (const activity of list.items) byId.set(activity.id, activity);
          return [...byId.values()].sort((a, b) => a.seq - b.seq);
        });
      }
      activitySeqRef.current = Math.max(activitySeqRef.current, list.next_after_seq);
    } catch {
      /* the trace is secondary; keep the transcript usable */
    }
  }, []);

  // Load the final message list (fallback / final text) on selection.
  React.useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setMessagesLoading(false);
      return;
    }
    let alive = true;
    setMessages([]);
    setMessagesLoading(true);
    cairn
      .listMessages(selectedId)
      .then((messageList) => {
        if (!alive) return;
        setMessages(messageList.items);
        setThreadError(null);
      })
      .catch((cause: Error) => {
        if (alive) setThreadError(cause.message);
      })
      .finally(() => {
        if (alive) setMessagesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  // Load the live activity trace from seq 0 on selection.
  React.useEffect(() => {
    if (!selectedId) {
      setActivities([]);
      activitySeqRef.current = 0;
      return;
    }
    let alive = true;
    setActivities([]);
    activitySeqRef.current = 0;
    cairn
      .listChatActivities(selectedId, 0)
      .then((list) => {
        if (!alive) return;
        setActivities(list.items);
        activitySeqRef.current = list.next_after_seq;
      })
      .catch(() => {
        if (alive) setActivities([]);
      });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  // Live poll while the turn is in flight: start immediately, then every 1s.
  // Incremental activities use after_seq; stop when the conversation is done.
  React.useEffect(() => {
    if (!selectedId) return;
    if (!sending && active?.status !== "running") return;
    const tick = () => {
      void refreshMessages(selectedId);
      void refreshActivities(selectedId);
      void refreshConversations(false);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [selectedId, sending, active?.status, refreshMessages, refreshActivities, refreshConversations]);

  // Keep the view pinned to the live tail only while the user is at the bottom.
  // Polling updates must never yank the transcript back down after a scroll-up.
  const scrollToBottom = React.useCallback(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  const handleTranscriptScroll = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin whenever transcript content changes
  React.useLayoutEffect(() => {
    if (pane !== "transcript" || !stickRef.current) return;
    const pin = () => {
      // Re-check at execution: the user may have scrolled up between the
      // effect and the deferred frame/settle pass.
      if (stickRef.current) scrollToBottom();
    };
    pin();
    // A second frame / settle pass catches Markdown, fonts and tool cards that
    // finish laying out after the first paint.
    const raf = requestAnimationFrame(pin);
    const timer = window.setTimeout(pin, 90);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [timelineActivities, pendingUser, pane, scrollToBottom]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe when the transcript root changes
  React.useEffect(() => {
    if (pane !== "transcript") return;
    const element = scrollRef.current;
    if (!element) return;
    const target = element.firstElementChild ?? element;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) scrollToBottom();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [selectedId, pane, timelineActivities.length, scrollToBottom]);

  const insertMention = (item: MentionItem) => {
    setDraft((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${item.id} `);
    setMentionOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const steer = async () => {
    const message = steerText.trim();
    if (!message || !selectedId || steering) return;
    setSteering(true);
    try {
      const result = await cairn.steerConversation(selectedId, message);
      if (!result.accepted) {
        const detail = result.detail ?? "Steering was not accepted.";
        setSteerNotices((current) => [
          ...current,
          { id: `${Date.now()}-${current.length}`, message: detail, at: Date.now() },
        ]);
      } else {
        setSteerText("");
        toast.success("Steer accepted", {
          description: result.disposition ? `Disposition: ${result.disposition}` : undefined,
        });
        void refreshActivities(selectedId);
        void refreshConversations(false);
      }
    } catch (cause) {
      const detail = (cause as Error).message;
      const message =
        cause instanceof CairnApiError && cause.status === 409
          ? "The turn already ended or steering is unavailable; refreshing the conversation."
          : detail;
      // One persistent inline notice in the transcript. No error toast over the
      // composer (the R4 UI showed both a toast and an inline error).
      setSteerNotices((current) => [...current, { id: `${Date.now()}-${current.length}`, message, at: Date.now() }]);
      void refreshConversations(false);
      void refreshMessages(selectedId);
      void refreshActivities(selectedId);
    } finally {
      setSteering(false);
    }
  };

  const startNewConversation = () => {
    setSelectedId(null);
    selectedRef.current = null;
    setMessages([]);
    setActivities([]);
    setPendingUser(null);
    setSendError(null);
    setThreadError(null);
    setDraft("");
    setPane("transcript");
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;

    setDraft("");
    setSendError(null);
    setPendingUser(text);
    setSending(true);
    setThinkingSince(Date.now());
    setPane("transcript");
    stickRef.current = true;

    let conversationId = selectedId;
    try {
      if (conversationId) {
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, status: "running" as const, last_message: text }
              : conversation,
          ),
        );
      }
      if (!conversationId) {
        const conversation = await cairn.createConversation(projectId, text.slice(0, 80));
        conversationId = conversation.id;
        const running = {
          ...conversation,
          status: "running" as const,
          last_message: text,
          message_count: 1,
        };
        setConversations((current) => [running, ...current]);
        setSelectedId(conversation.id);
        selectedRef.current = conversation.id;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      await cairn.sendMessage(conversationId, text, controller.signal);
      await Promise.all([
        refreshMessages(conversationId),
        refreshActivities(conversationId),
        refreshConversations(false),
      ]);
    } catch (cause) {
      if ((cause as Error).name === "AbortError") {
        toast.info("Turn stopped");
      } else {
        const message = (cause as Error).message;
        setSendError(message);
        toast.error("Message failed", { description: message });
      }
      if (conversationId) {
        await Promise.all([refreshMessages(conversationId), refreshActivities(conversationId)]);
      } else {
        setDraft(text);
      }
      await refreshConversations(false);
    } finally {
      setSending(false);
      setThinkingSince(null);
      setPendingUser(null);
      abortRef.current = null;
    }
  };

  const stop = async () => {
    if (!selectedId) return;
    try {
      const result = await cairn.stopConversation(selectedId);
      toast.info(result.reconciled ? "The turn had already ended" : "Stopping the turn…");
      abortRef.current?.abort();
      setSending(false);
      setThinkingSince(null);
      setPendingUser(null);
      await Promise.all([refreshMessages(selectedId), refreshActivities(selectedId), refreshConversations(false)]);
    } catch (cause) {
      toast.error("Could not stop the turn", { description: (cause as Error).message });
    }
  };

  const removeConversation = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await cairn.deleteConversation(deleteTarget.id);
      toast.success("Conversation deleted");
      if (selectedRef.current === deleteTarget.id) {
        setSelectedId(null);
        selectedRef.current = null;
      }
      setConversations((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      await refreshConversations(true);
    } catch (cause) {
      toast.error("Could not delete the conversation", { description: (cause as Error).message });
    } finally {
      setDeleting(false);
    }
  };

  const showPendingUser =
    pendingUser !== null &&
    !messages.some((message) => message.role === "user" && message.content === pendingUser) &&
    !activities.some(
      (activity) => activity.kind === "message" && activity.role === "user" && activity.content === pendingUser,
    );
  const trace = activities.filter(
    (activity) => !TRACE_SKIP.has(activity.kind) && !(activity.kind === "message" && !activity.content),
  );

  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-xl bg-card text-sm ring-1 ring-foreground/10",
        compact ? "h-[68vh] min-h-[520px]" : "h-[calc(100dvh-12.5rem)] min-h-[560px]",
      )}
    >
      {/* Conversation list */}
      <aside className="hidden w-[280px] shrink-0 flex-col border-r lg:flex">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <MessagesSquareIcon className="size-4 text-muted-foreground" />
            Conversations
            <span className="text-[11px] font-normal text-muted-foreground">{conversations.length}</span>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={startNewConversation}
            disabled={sending}
            aria-label="New conversation"
          >
            <PlusIcon />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={`conversation-skeleton-${index.toString()}`} className="h-12 w-full" />
              ))}
            </div>
          ) : listError ? (
            <div className="p-3 text-[11px] text-destructive">{listError}</div>
          ) : conversations.length === 0 ? (
            <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
              No conversations yet. Send a message to start one.
            </div>
          ) : (
            <div className="flex flex-col">
              {conversations.map((conversation) => {
                const selected = conversation.id === selectedId;
                const rowRunning = sending && selected;
                const rowStopped = selected && !sending && latestAssistant?.status === "stopped";
                return (
                  <div key={conversation.id} className={cn("group relative", selected && "bg-muted/60")}>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => setSelectedId(conversation.id)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 px-3 py-2.5 pr-9 text-left transition-colors hover:bg-muted/40",
                        selected && "hover:bg-muted/60",
                        sending && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            rowRunning || conversation.status === "running"
                              ? "animate-pulse bg-blue-500"
                              : rowStopped
                                ? "bg-slate-500"
                                : conversation.status === "error"
                                  ? "bg-red-500"
                                  : "bg-muted-foreground/40",
                          )}
                        />
                        <span className="truncate text-xs font-medium">{conversation.title}</span>
                        {rowStopped && (
                          <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                            Stopped
                          </Badge>
                        )}
                      </span>
                      <span className="truncate pl-3 text-[11px] text-muted-foreground">
                        {rowRunning
                          ? "Running…"
                          : rowStopped
                            ? "Turn stopped"
                            : conversation.last_message
                              ? oneLine(conversation.last_message)
                              : conversation.message_count > 0
                                ? "No text returned"
                                : "No messages yet"}
                      </span>
                      <span className="pl-3 text-[11px] text-muted-foreground/80">
                        {rowRunning ? "now" : formatRelative(conversation.updated_at)} · {conversation.message_count}{" "}
                        msg · {conversation.activity_count ?? 0} act
                      </span>
                      <span className="pl-3 text-[11px] text-muted-foreground/70">
                        {formatNumber(conversation.tokens_in ?? 0)} in · {formatNumber(conversation.tokens_out ?? 0)}{" "}
                        out
                      </span>
                    </button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={sending}
                      className="absolute top-2 right-1.5 size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => setDeleteTarget(conversation)}
                      aria-label={`Delete ${conversation.title}`}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          {projectTitle ?? projectId} · main agent
        </div>
      </aside>

      {/* Chat pane */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold">{active?.title ?? "New conversation"}</span>
              {(active || sending) && (
                <StatusBadge domain="cairnFeed" value={displayStatus} dot className="px-1.5 py-0 text-[11px]" />
              )}
              {active && (
                <Badge variant="outline" className="px-1.5 py-0 font-mono text-[11px]">
                  #{active.id}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="truncate">{projectTitle ?? projectId}</span>
              {active && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{formatNumber(active.message_count)} msg</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{formatNumber(active.tokens_in ?? 0)} in</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{formatNumber(active.tokens_out ?? 0)} out</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{formatNumber(active.activity_count ?? 0)} activities</span>
                  {sending && (
                    <>
                      <span className="text-muted-foreground/50">·</span>
                      <span>waiting for the reply…</span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="lg:hidden">
              <Select
                value={selectedId ? String(selectedId) : "new"}
                onValueChange={(value) => setSelectedId(value === "new" ? null : Number(value))}
                disabled={sending}
              >
                <SelectTrigger size="sm" className="h-8 w-40 text-xs">
                  <SelectValue placeholder="Conversation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new" className="text-xs">
                    New conversation
                  </SelectItem>
                  {conversations.map((conversation) => (
                    <SelectItem key={conversation.id} value={String(conversation.id)} className="text-xs">
                      {conversation.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Tabs value={pane} onValueChange={(value) => setPane(value as Pane)}>
              <TabsList className="h-8">
                <TabsTrigger value="transcript" className="text-xs">
                  Transcript
                </TabsTrigger>
                <TabsTrigger value="activity" className="text-xs">
                  Activity
                  {trace.length > 0 && (
                    <span className="ml-1 rounded bg-muted px-1 text-[11px] text-muted-foreground">{trace.length}</span>
                  )}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => {
                if (selectedId) {
                  void refreshMessages(selectedId);
                  void refreshActivities(selectedId);
                }
                void refreshConversations(false);
              }}
              aria-label="Refresh conversation"
            >
              <RefreshCwIcon />
            </Button>
            {compact && (
              <Button size="icon-sm" variant="outline" asChild aria-label="Open the full conversations page">
                <Link prefetch={false} href={`/chat?project=${encodeURIComponent(projectId)}`}>
                  <ExternalLinkIcon />
                </Link>
              </Button>
            )}
          </div>
        </div>

        {pane === "transcript" ? (
          <div ref={scrollRef} onScroll={handleTranscriptScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {messagesLoading && timelineActivities.length === 0 ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-10 w-2/3 self-end" />
                <Skeleton className="h-16 w-3/4" />
              </div>
            ) : (
              <CairnChatTimeline
                activities={timelineActivities}
                pendingUser={showPendingUser ? pendingUser : null}
                thinking={thinking}
                thinkingSince={thinkingSince}
                steerNotices={steerNotices}
              />
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {trace.length === 0 ? (
              <div className="py-10 text-center text-xs text-muted-foreground">
                No activity trace yet. Tool calls and reasoning appear here after a turn.
              </div>
            ) : (
              <div className="divide-y">
                {trace.map((activity) => {
                  const meta = traceMeta(activity);
                  const Icon = meta.icon;
                  const usage = activity.kind === "usage" ? parseUsage(activity.content) : null;
                  const blocks: Array<{ label: string | null; text: string }> =
                    activity.kind === "tool_call"
                      ? [
                          ...(activity.tool_input ? [{ label: "Input", text: activity.tool_input }] : []),
                          ...(activity.tool_output ? [{ label: "Output", text: activity.tool_output }] : []),
                        ]
                      : activity.content
                        ? [{ label: null, text: activity.content }]
                        : [];
                  return (
                    <div key={activity.id} className="flex items-start gap-3 py-2.5">
                      <span className="w-12 shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground">
                        {formatRelative(activity.created_at)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Badge variant="outline" className={cn("gap-1 px-1.5 py-0 text-[11px]", meta.className)}>
                            <Icon className="size-3" />
                            {meta.label}
                          </Badge>
                          {activity.tool_name && (
                            <span className="font-mono text-[11px] text-muted-foreground">{activity.tool_name}</span>
                          )}
                          <StatusBadge
                            domain="cairnFeed"
                            value={activity.status}
                            dot
                            className="px-1.5 py-0 text-[11px]"
                          />
                          <span className="font-mono text-[11px] text-muted-foreground/70">#{activity.seq}</span>
                          {activity.tokens_in || activity.tokens_out ? (
                            <span className="text-[11px] text-muted-foreground">
                              {formatNumber(activity.tokens_in ?? 0)} in · {formatNumber(activity.tokens_out ?? 0)} out
                            </span>
                          ) : null}
                        </div>
                        {usage ? (
                          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span>Input {formatNumber(usage.input ?? 0)}</span>
                            <span>Output {formatNumber(usage.output ?? 0)}</span>
                            {usage.cacheRead ? <span>Cache read {formatNumber(usage.cacheRead)}</span> : null}
                            {usage.totalTokens ? <span>Total {formatNumber(usage.totalTokens)}</span> : null}
                          </div>
                        ) : (
                          blocks.map((block) => (
                            <div key={block.label ?? "content"}>
                              {block.label && (
                                <div className="mt-1.5 text-[11px] text-muted-foreground">{block.label}</div>
                              )}
                              <pre className="mt-1 max-h-40 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                                {block.text.length > 4000 ? `${block.text.slice(0, 4000)}…` : block.text}
                              </pre>
                            </div>
                          ))
                        )}
                        {activity.error && <div className="mt-1 text-[11px] text-destructive">{activity.error}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="border-t p-3">
          {thinking && selectedId && (
            <div className="mb-2 rounded-lg border border-dashed bg-muted/20 p-2">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <RadioTowerIcon className="size-3.5" />
                Steer the running turn
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={steerText}
                  onChange={(event) => setSteerText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void steer();
                    }
                  }}
                  placeholder="Add guidance mid-turn…"
                  className="h-8 flex-1 text-xs"
                  disabled={steering}
                  aria-label="Steer message"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void steer()}
                  disabled={!steerText.trim() || steering}
                >
                  {steering ? (
                    <Loader2Icon data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <RadioTowerIcon data-icon="inline-start" />
                  )}
                  Steer
                </Button>
              </div>
            </div>
          )}

          {sendError && <div className="mb-2 text-[11px] text-destructive">{sendError}</div>}
          {threadError && <div className="mb-2 text-[11px] text-destructive">{threadError}</div>}
          <div className="rounded-xl border bg-background p-1.5">
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={active ? "Message the main agent…" : "Start a conversation…"}
              rows={2}
              className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
              disabled={thinking}
            />
            <div className="mt-1 flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-1">
                {mentionItems.length > 0 && (
                  <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        disabled={thinking}
                        aria-label="Mention a fact or intent"
                      >
                        <AtSignIcon data-icon="inline-start" />
                        Mention
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 p-0">
                      <Command>
                        <CommandInput placeholder="Reference a fact or intent…" />
                        <CommandList className="max-h-72">
                          <CommandEmpty>No references found.</CommandEmpty>
                          <CommandGroup heading="References">
                            {mentionItems.map((item) => (
                              <CommandItem
                                key={item.id}
                                value={`${item.id} ${item.text}`}
                                onSelect={() => insertMention(item)}
                              >
                                <span className="flex min-w-0 flex-col">
                                  <span className="font-mono text-[11px]">{item.id}</span>
                                  <span className="truncate text-[11px] text-muted-foreground">{item.text}</span>
                                </span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
              <div className="flex items-center gap-2">
                {thinking ? (
                  <Button size="icon-sm" variant="outline" onClick={() => void stop()} aria-label="Stop the turn">
                    <SquareIcon />
                  </Button>
                ) : (
                  <Button size="icon-sm" onClick={() => void send()} disabled={!draft.trim()} aria-label="Send message">
                    <ArrowUpIcon />
                  </Button>
                )}
              </div>
            </div>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Enter to send · Shift+Enter for a new line</span>
            <span>{sending ? "Waiting for the main agent…" : "One turn at a time"}</span>
          </div>
        </div>
      </section>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.title} and its messages/trace will be removed from Cairn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void removeConversation()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete conversation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
