"use client";

import { createContext, useContext } from "react";

/** Prefills the session reply composer with a ready-to-send message and focuses
 * it. SessionView provides it; surfaces outside the composer (e.g. a conflicted
 * workpiece proposal offering "Ask agent to redo") consume it. Null outside a
 * session - the standalone artifacts page has no composer, so the affordance
 * that depends on it hides itself. */
export type PrefillComposer = (text: string) => void;

const ComposerPrefillContext = createContext<PrefillComposer | null>(null);

export const ComposerPrefillProvider = ComposerPrefillContext.Provider;

export function useComposerPrefill(): PrefillComposer | null {
  return useContext(ComposerPrefillContext);
}
