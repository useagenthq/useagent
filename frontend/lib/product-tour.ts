/** Small client store shared by the composer invitation and account menu.
 * Dismissal is remembered per person and browser; existing seen keys stay valid.
 * The four steps and modal load only when requested. */

export type TourState =
  | { readonly phase: "idle" }
  | { readonly phase: "offer"; readonly userId: string }
  | { readonly phase: "touring"; readonly userId: string | null };

const IDLE: TourState = { phase: "idle" };
let state: TourState = IDLE;
const listeners = new Set<() => void>();

function setState(next: TourState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeTour(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function tourSnapshot(): TourState {
  return state;
}

export function tourServerSnapshot(): TourState {
  return IDLE;
}

const seenKey = (userId: string) => `product-tour-seen:${userId}`;
/** Held for the page's lifetime too, so a browser that refuses storage does not
 *  offer the tour again on every client-side visit to the composer. */
const seenHere = new Set<string>();

/** Per browser: a person who finished or declined the tour is not offered it again. */
export function tourSeen(userId: string): boolean {
  if (seenHere.has(userId)) return true;
  try {
    return window.localStorage.getItem(seenKey(userId)) !== null;
  } catch {
    return false;
  }
}

function markTourSeen(userId: string, outcome: "completed" | "dismissed"): void {
  seenHere.add(userId);
  try {
    window.localStorage.setItem(seenKey(userId), outcome);
  } catch {
    // A browser that refuses storage may offer the tour again after a full reload; nothing else depends on it.
  }
}

/** Offer the tour (a small card the person accepts or declines). Only from rest,
 *  and never to someone who already finished or declined it here. */
export function offerTour(userId: string): void {
  if (state.phase !== "idle" || tourSeen(userId)) return;
  setState({ phase: "offer", userId });
}

/** Start at the first step: from the offer, or from the account menu at any time. */
export function startTour(userId: string | null): void {
  setState({ phase: "touring", userId });
}

/** End the tour or the offer and remember it for this person in this browser. */
export function finishTour(outcome: "completed" | "dismissed"): void {
  if (state.phase === "idle") return;
  if (state.userId) markTourSeen(state.userId, outcome);
  setState(IDLE);
}

/** Tests only: back to rest with nothing remembered. */
export function resetTourForTests(): void {
  seenHere.clear();
  setState(IDLE);
}
