"use client";

import { SessionsView } from "./sessions-view";

export function ConversationsTab({
  projectId,
  projectTitle,
  onOpenWorkers,
}: {
  projectId: string;
  projectTitle?: string;
  onOpenWorkers?: () => void;
}) {
  return <SessionsView projectId={projectId} projectTitle={projectTitle} onOpenWorkers={onOpenWorkers} />;
}
