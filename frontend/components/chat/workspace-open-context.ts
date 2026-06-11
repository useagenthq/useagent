"use client";

import { createContext, useContext } from "react";
import type { TimelineArtifact } from "./timeline";

/** Opens a canonical workpiece artifact in the session's side-pane Workspace.
 * SessionView provides it; conversation artifact cards consume it. Null outside a
 * session (e.g. the standalone artifacts page), where cards keep card/download. */
export type OpenWorkpiece = (artifact: Pick<TimelineArtifact, "id" | "name">) => void;

const WorkspaceOpenContext = createContext<OpenWorkpiece | null>(null);

export const WorkspaceOpenProvider = WorkspaceOpenContext.Provider;

export function useOpenWorkpiece(): OpenWorkpiece | null {
  return useContext(WorkspaceOpenContext);
}
