"use client";

import * as React from "react";

import Link from "next/link";
import { useParams } from "next/navigation";

import { ArrowLeftIcon, FolderKanbanIcon, PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCairnProject } from "@/hooks/use-cairn";
import { cairn } from "@/lib/cairn-api";
import { formatDate, oneLine } from "@/lib/cairn-format";
import { cn } from "@/lib/utils";

import { ApprovalsTab } from "./_components/approvals-tab";
import { BroadcastTab } from "./_components/broadcast-tab";
import { ConversationsTab } from "./_components/conversations-tab";
import { CoverageGraphTab } from "./_components/coverage-graph-tab";
import { EntitiesTab } from "./_components/entities-tab";
import { FindingsTab } from "./_components/findings-tab";
import { RetestsTab } from "./_components/retests-tab";
import { GraphTab } from "./_components/graph-tab";
import { OverviewTab } from "./_components/overview-tab";
import { ReportTab } from "./_components/report-tab";

const TABS = [
  { value: "conversations", label: "Conversations" },
  { value: "overview", label: "Overview" },
  { value: "graph", label: "Exploration graph" },
  { value: "broadcast", label: "Broadcast board" },
  { value: "findings", label: "Findings" },
  { value: "retests", label: "Retests" },
  // Generalized Artex domain layer; rendered only when the graph has entities.
  { value: "assets", label: "Test assets" },
  { value: "coverage", label: "Asset coverage" },
  { value: "approvals", label: "Interception approvals" },
  { value: "report", label: "Report" },
];

export default function ProjectDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  // Artex task detail opens on Conversations; the workspace follows the same order.
  const [tab, setTab] = React.useState("conversations");
  const [graphFocus, setGraphFocus] = React.useState<string | undefined>(undefined);
  const [entityFocus, setEntityFocus] = React.useState<string | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [statusBusy, setStatusBusy] = React.useState(false);

  const { detail, loading, error, refresh } = useCairnProject(id, 4000);

  const project = detail?.project ?? null;
  const unavailable = !loading && !detail && !!error;
  const nextStatus = project?.status === "active" ? "stopped" : "active";
  const goal = detail?.facts.find((fact) => fact.id === "goal")?.description;

  const entities = detail?.entities ?? [];
  const coverage = detail?.coverage ?? null;
  // Data decides visibility: no profiles, no invented placeholders.
  const showAssets = entities.length > 0;
  const showCoverage = (coverage?.denominator ?? 0) > 0 || entities.length > 0;
  const showRetests = (detail?.findings?.length ?? 0) > 0;
  const visibleTabs = TABS.filter((item) => {
    if (item.value === "assets") return showAssets;
    if (item.value === "coverage") return showCoverage;
    if (item.value === "retests") return showRetests;
    return true;
  });

  React.useEffect(() => {
    if (
      (tab === "assets" && !showAssets) ||
      (tab === "coverage" && !showCoverage) ||
      (tab === "retests" && !showRetests)
    ) {
      setTab("overview");
    }
  }, [showAssets, showCoverage, showRetests, tab]);

  const openGraph = (nodeId: string) => {
    setGraphFocus(nodeId);
    setTab("graph");
  };

  const openFindings = () => {
    setTab("findings");
  };

  const focusEntity = (entityId: string) => {
    setEntityFocus(entityId);
    setTab("assets");
  };

  const applyStatus = async () => {
    if (!project) return;
    setStatusBusy(true);
    try {
      await cairn.updateProjectStatus(project.id, nextStatus);
      toast.success(nextStatus === "stopped" ? "Project paused" : "Project resumed");
      await refresh();
    } catch (cause) {
      toast.error("Could not update the project status", { description: (cause as Error).message });
    } finally {
      setStatusBusy(false);
      setConfirmOpen(false);
    }
  };

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value);
        if (value !== "graph") setGraphFocus(undefined);
        if (value !== "assets") setEntityFocus(undefined);
      }}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      {/* Artex task-detail header: compact, topbar-height, project purpose underneath. */}
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-3 lg:px-4">
        <SidebarTrigger className="-ml-1" />
        <Button size="icon-sm" variant="ghost" asChild className="size-8 shrink-0">
          <Link prefetch={false} href="/projects" aria-label="Back to projects">
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">
          {project?.title ?? (unavailable ? "Project not found" : "Project")}
        </h1>
        {project && <StatusBadge domain="project" value={project.status} dot className="px-1.5 py-0 text-[11px]" />}
        <Badge variant="outline" className="hidden px-1.5 py-0 font-mono text-[11px] sm:inline-flex">
          {id ?? "—"}
        </Badge>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh project"
          >
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
          </Button>
          {project && project.status !== "completed" && (
            <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)} disabled={statusBusy}>
              {project.status === "active" ? (
                <PauseIcon data-icon="inline-start" />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {project.status === "active" ? "Pause" : "Resume"}
            </Button>
          )}
        </div>
      </header>

      <div className="shrink-0 px-4 pt-2 lg:px-6">
        <p className="line-clamp-1 text-xs text-muted-foreground">
          {project
            ? `Created ${formatDate(project.created_at)} · ${oneLine(goal ?? "No goal recorded.")}`
            : unavailable
              ? "This project could not be loaded from Cairn."
              : "Loading project…"}
        </p>
        {!unavailable && (
          <div className="mt-2 min-w-0">
            <TabsList variant="default" className="flex-wrap justify-start group-data-horizontal/tabs:h-auto">
              {visibleTabs.map((item) => (
                <TabsTrigger key={item.value} value={item.value} className="text-[13px] xl:text-sm">
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 lg:p-6">
        {error && (
          <Alert variant="destructive" className="mb-6">
            <FolderKanbanIcon />
            <AlertTitle>{unavailable ? "Project not found" : "Cairn API unreachable"}</AlertTitle>
            <AlertDescription>
              <span className="font-mono text-[11px]">{error}</span>
              {detail && (
                <span className="block text-xs text-muted-foreground">Showing the last successful snapshot.</span>
              )}
            </AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                Retry
              </Button>
            </AlertAction>
            {unavailable && (
              <Button size="sm" variant="ghost" className="mt-2 w-fit" asChild>
                <Link prefetch={false} href="/projects">
                  <ArrowLeftIcon data-icon="inline-start" />
                  Back to projects
                </Link>
              </Button>
            )}
          </Alert>
        )}

        {!unavailable && (
          <>
            <TabsContent value="conversations" className="mt-0">
              {id && <ConversationsTab projectId={id} projectTitle={project?.title} />}
            </TabsContent>

            <TabsContent value="overview" className="mt-0">
              {id && (
                <OverviewTab
                  projectId={id}
                  detail={detail}
                  loading={loading}
                  onOpenBroadcast={() => setTab("broadcast")}
                />
              )}
            </TabsContent>

            <TabsContent value="graph" className="mt-0 flex min-h-0 flex-1 flex-col">
              <GraphTab detail={detail} loading={loading} focusNodeId={graphFocus} />
            </TabsContent>

            <TabsContent value="assets" className="mt-0">
              {id && (
                <EntitiesTab
                  projectId={id}
                  detail={detail}
                  loading={loading}
                  refresh={refresh}
                  focusEntityId={entityFocus}
                  onOpenGraph={openGraph}
                  onOpenFindings={openFindings}
                />
              )}
            </TabsContent>

            <TabsContent value="coverage" className="mt-0">
              {id && (
                <CoverageGraphTab
                  projectId={id}
                  detail={detail}
                  loading={loading}
                  onOpenGraph={openGraph}
                  onFocusEntity={focusEntity}
                />
              )}
            </TabsContent>

            <TabsContent value="broadcast" className="mt-0">
              {id && (
                <BroadcastTab projectId={id} projectTitle={project?.title} detail={detail} onOpenGraph={openGraph} />
              )}
            </TabsContent>

            <TabsContent value="findings" className="mt-0">
              {id && (
                <FindingsTab
                  projectId={id}
                  detail={detail}
                  loading={loading}
                  onOpenGraph={openGraph}
                  onOpenRetests={() => setTab("retests")}
                  onRefresh={() => void refresh()}
                />
              )}
            </TabsContent>

            <TabsContent value="retests" className="mt-0">
              {id && (
                <RetestsTab
                  projectId={id}
                  detail={detail}
                  loading={loading}
                  onRefresh={() => void refresh()}
                  onOpenFindings={() => setTab("findings")}
                />
              )}
            </TabsContent>

            <TabsContent value="approvals" className="mt-0">
              {id && <ApprovalsTab projectId={id} />}
            </TabsContent>

            <TabsContent value="report" className="mt-0">
              <ReportTab detail={detail} loading={loading} onOpenGraph={openGraph} />
            </TabsContent>
          </>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {nextStatus === "stopped" ? "Pause this project?" : "Resume this project?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This updates the live Cairn project status.{" "}
              {nextStatus === "stopped"
                ? "The dispatcher stops claiming new intents for this project."
                : "The dispatcher can claim new intents for this project again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void applyStatus()} disabled={statusBusy}>
              {statusBusy ? "Saving…" : nextStatus === "stopped" ? "Pause project" : "Resume project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
