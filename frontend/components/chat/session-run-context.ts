"use client";

import { createContext, useContext } from "react";

/** The current/latest run of the viewed thread - the run the user's own most-recent
 * message started. SessionView provides it; the workpiece proposal lane reads it to
 * decide whether an agent change came from the user's own request (requested-edit
 * auto-accept). Null outside a session (the standalone artifacts editor), where
 * auto-accept never applies. */
const SessionLatestRunContext = createContext<string | null>(null);

export const SessionLatestRunProvider = SessionLatestRunContext.Provider;

export function useSessionLatestRun(): string | null {
  return useContext(SessionLatestRunContext);
}
