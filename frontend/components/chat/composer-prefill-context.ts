"use client";

import { createContext, useContext } from "react";

/** Prefills the session reply composer with a ready-to-send message and focuses
 * it. SessionView provides it; surfaces outside the composer (e.g. a conflicted
 * workpiece proposal offering "Ask agent to redo") consume it. Null outside a
 * session - the standalone artifacts page has no composer, so the affordance
 * that depends on it hides itself. The text replaces the draft unless `append`
 * asks to add it under a non-empty one (diff comments joining a half-written reply). */
export type PrefillComposer = (text: string, options?: { readonly append?: boolean }) => void;

/** One prefill request as the composer receives it. The `nonce` makes each request
 *  re-apply even when the text repeats. */
export interface ComposerPrefill {
  readonly text: string;
  readonly nonce: number;
  readonly append?: boolean;
}

const ComposerPrefillContext = createContext<PrefillComposer | null>(null);

export const ComposerPrefillProvider = ComposerPrefillContext.Provider;

export function useComposerPrefill(): PrefillComposer | null {
  return useContext(ComposerPrefillContext);
}
