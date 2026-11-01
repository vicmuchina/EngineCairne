"use client";

import * as React from "react";

import { useRouter, useSearchParams } from "next/navigation";

import { MessagesSquareIcon, RefreshCwIcon } from "lucide-react";

import { CairnChat } from "@/components/cairn-chat";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useCairnProjects } from "@/hooks/use-cairn";
import { cn } from "@/lib/utils";

function ChatFallback() {
  return (
    <div className="flex flex-1 flex-col gap-6 pb-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Conversations</h1>
        <p className="mt-1 text-sm text-muted-foreground">Main agent chat, scoped to a Cairn project.</p>
      </div>
      <Skeleton className="h-[calc(100dvh-12.5rem)] min-h-[560px] w-full rounded-xl" />
    </div>
  );
}

function ChatPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryProject = searchParams.get("project") ?? "";
  const { projects, loading, refreshing, error, refresh } = useCairnProjects(0);

  const [projectId, setProjectId] = React.useState(queryProject);

  React.useEffect(() => {
    if (queryProject) setProjectId(queryProject);
  }, [queryProject]);

  React.useEffect(() => {
    if (projectId && projects.some((project) => project.id === projectId)) return;
    const first = projects[0]?.id;
    if (!first) return;
    setProjectId(first);
    if (!queryProject) router.replace(`/chat?project=${encodeURIComponent(first)}`, { scroll: false });
  }, [projects, projectId, queryProject, router]);

  const project = projects.find((item) => item.id === projectId);

  return (
    <div className="flex flex-1 flex-col gap-6 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <MessagesSquareIcon className="size-4.5 text-muted-foreground" />
            Conversations
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Main agent chat, scoped to a Cairn project. Messages and tool traces stay in the conversation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Project</span>
          <Select
            value={projectId}
            onValueChange={(value) => {
              setProjectId(value);
              router.replace(`/chat?project=${encodeURIComponent(value)}`, { scroll: false });
            }}
          >
            <SelectTrigger size="sm" className="h-8 w-56 text-xs" aria-label="Project">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((item) => (
                <SelectItem key={item.id} value={item.id} className="text-xs">
                  {item.title}
                  <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{item.id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCwIcon data-icon="inline-start" className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <MessagesSquareIcon />
          <AlertTitle>Cairn API unreachable</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-[11px]">{error}</span>
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}

      {loading ? (
        <Skeleton className="h-[calc(100dvh-12.5rem)] min-h-[560px] w-full rounded-xl" />
      ) : projectId ? (
        <CairnChat key={projectId} projectId={projectId} projectTitle={project?.title} />
      ) : (
        <div className="flex h-[40vh] items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
          No Cairn projects yet. Create one to start a conversation.
        </div>
      )}
    </div>
  );
}

export default function ChatPage() {
  return (
    <React.Suspense fallback={<ChatFallback />}>
      <ChatPageInner />
    </React.Suspense>
  );
}
