"use client";

import dynamic from "next/dynamic";

// The Workspace pane pulls in the workpiece editor surfaces + revision hook. Code
// split it so that weight loads ONLY when a user first opens a workpiece - it must
// never sit in the base session bundle (the pane is already mount-gated, this keeps
// its JS out of first load too).
export const WorkspacePane = dynamic(
  () => import("@/components/chat/workspace-pane").then((mod) => mod.WorkspacePane),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-full place-items-center p-6 text-body-2-regular text-text-secondary">
        Loading workspace...
      </div>
    ),
  },
);
