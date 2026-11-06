"use client";

import { useEffect } from "react";
import { useSession } from "@/lib/auth";
import { offerTour } from "@/lib/product-tour";

/** Long enough that the page settles and the person sees it before anything else appears. */
export const TOUR_OFFER_DELAY_MS = 1200;

/**
 * Offers the product tour to a signed-in person who has no threads yet, once
 * per browser: the offer is a corner card they accept or decline, never a
 * forced walkthrough, and the composer stays usable throughout.
 */
export function TourLauncher({ newUser }: { newUser: boolean }) {
  const { session, loading } = useSession();
  useEffect(() => {
    if (!newUser || loading || !session) return;
    const userId = session.user.id;
    const handle = window.setTimeout(() => offerTour(userId), TOUR_OFFER_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [newUser, loading, session]);
  return null;
}
