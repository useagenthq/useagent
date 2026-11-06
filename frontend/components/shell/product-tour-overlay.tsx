"use client";

import { RiCompass3Line } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/base/buttons/button";
import * as Modal from "@/components/base/modal/modal";
import { finishTour, startTour, type TourState } from "@/lib/product-tour";

export const TOUR_STEPS = [
  {
    title: "Start with a task",
    body: "Describe what you want done, choose an agent and a model, then send your message. Each thread keeps its own files and history so you can return to it later.",
  },
  {
    title: "Follow the work",
    body: "See each step as your agent works. Open its browser or terminal, answer questions, or stop the task when you need to make a change.",
  },
  {
    title: "Find your files",
    body: "Open the files your agent creates from the thread. Use Library in the sidebar to find them again, or Dashboard to check on your tasks.",
  },
  {
    title: "Connect a model",
    body: "Open Settings, then Provider connections, to connect an account or add an API key. A provider marked Provided by this deployment is already available. You can take this tour again from the account menu.",
  },
] as const;

/** A quiet invitation: it never takes focus or blocks the composer. */
export function TourOfferCard({ onStart, onDecline }: { onStart: () => void; onDecline: () => void }) {
  return (
    <section
      aria-label="Product tour"
      className="w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-dropdown"
    >
      <div className="flex items-start gap-3">
        <RiCompass3Line className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden />
        <div className="min-w-0 flex-1" aria-live="polite">
          <h2 className="text-body-2-medium text-text-primary">Welcome to UseAgent</h2>
          <p className="mt-1 text-body-2-regular text-text-secondary">
            Get started with a four-step tour. You can open it any time from the account menu.
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={onDecline}>Not now</Button>
        <Button variant="primary" size="xs" onClick={onStart}>Start tour</Button>
      </div>
    </section>
  );
}

export function TourStepCard({
  index,
  onBack,
  onNext,
  onSettings,
}: {
  index: number;
  onBack: () => void;
  onNext: () => void;
  onSettings: () => void;
}) {
  const step = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;
  return (
    <>
      <p className="pr-8 text-caption-1-regular tabular-nums text-text-tertiary">
        {index + 1} of {TOUR_STEPS.length}
      </p>
      <div aria-live="polite" aria-atomic="true">
        <Modal.Title className="mt-1 pr-8 text-body-2-medium">{step.title}</Modal.Title>
        <Modal.Description className="mt-1 text-body-2-regular">{step.body}</Modal.Description>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {last ? <Button variant="secondary" size="xs" onClick={onSettings}>Open settings</Button> : null}
        <span className="flex-1" />
        {index > 0 ? <Button variant="ghost" size="xs" onClick={onBack}>Back</Button> : null}
        <Button variant="primary" size="xs" onClick={onNext}>{last ? "Done" : "Next"}</Button>
      </div>
    </>
  );
}

/** Reuse the app's modal for focus, Escape and dismissal. No page navigation until requested. */
export function ProductTourOverlay({ state }: { state: Exclude<TourState, { phase: "idle" }> }) {
  const [index, setIndex] = useState(0);
  const router = useRouter();
  const dismiss = () => finishTour("dismissed");
  if (state.phase === "offer") {
    return (
      <div className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex justify-end sm:inset-x-auto sm:right-4 sm:bottom-4">
        <div className="pointer-events-auto">
          <TourOfferCard onStart={() => startTour(state.userId)} onDecline={dismiss} />
        </div>
      </div>
    );
  }
  return (
    <Modal.Root open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <Modal.Content
        instant
        className="max-w-[20rem] border border-border-button-default p-4"
      >
        <TourStepCard
          index={index}
          onBack={() => setIndex(index - 1)}
          onNext={() => {
            if (index === TOUR_STEPS.length - 1) finishTour("completed");
            else setIndex(index + 1);
          }}
          onSettings={() => {
            finishTour("completed");
            router.push("/settings#providers");
          }}
        />
      </Modal.Content>
    </Modal.Root>
  );
}
