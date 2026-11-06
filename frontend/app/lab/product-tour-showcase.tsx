"use client";

import { Button } from "@/components/base/buttons/button";
import { TourOfferCard } from "@/components/shell/product-tour-overlay";
import { startTour } from "@/lib/product-tour";
import { useState } from "react";

/** The real invitation and modal, using the lab's normal app layout. */
export function ProductTourShowcase() {
  const [offered, setOffered] = useState(true);
  return (
    <div className="flex flex-col items-start gap-4">
      {offered ? <TourOfferCard onStart={() => startTour(null)} onDecline={() => setOffered(false)} /> : null}
      <Button variant="secondary" size="xs" onClick={() => startTour(null)}>Run the tour</Button>
    </div>
  );
}
