"use client";

import { useEffect, useState } from "react";
import type { OrbState } from "@/components/base/thinking-orb";
import { OrbPill } from "@/components/chat/orb-pill";
import { engineLabel, stalledStageElapsed, type EngineId, type RunStatus } from "@/components/chat/types";

/**
 * Boot-phase indicator for the session view. Shown only while a run is queued or
 * running-but-pre-first-step — the engine is spinning up and no activity has
 * streamed in yet. Rendered as an OrbPill so the boot phase reads with the same
 * orb vocabulary as the live working pill; it clears the moment the first step
 * arrives and the Thinking disclosure takes over (a distinct role).
 *
 * State mapping: sandbox provisioning → "shaping";
 * every other engine just spins its process up → "working".
 */
export function OrbBootIndicator({
  engine,
  status,
}: {
  engine: EngineId;
  status: RunStatus;
}) {
  const provisioning = engine === "daytona";
  const state: OrbState = status === "running" && provisioning ? "shaping" : "working";
  const label =
    status === "queued"
      ? "Queued"
      : provisioning
        ? "Provisioning sandbox"
        : `Booting ${engineLabel(engine)}`;

  // When this stage has not advanced for more than 2s during startup, tail the
  // label with whole-second elapsed time ("Booting OpenCode 4s") so a stalled
  // boundary reads as honest progress, not an open-ended spinner. The elapsed
  // clock resets whenever the stage label changes. aria-label stays stable so a
  // screen reader is not re-announced every second.
  const elapsed = stalledStageElapsed(useStageElapsedMs(label));

  return (
    <OrbPill
      state={state}
      label={elapsed ? `${label} ${elapsed}` : label}
      ariaLabel={`${label} - ${engineLabel(engine)}`}
    />
  );
}

/** Milliseconds the given stage has been the current one, ticked once a second.
 *  Resets to 0 when `stage` changes; anchored to a mount-relative monotonic clock
 *  so it measures this stage's dwell, not wall-clock since page load. */
function useStageElapsedMs(stage: string): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const start = performance.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(performance.now() - start), 1_000);
    return () => clearInterval(id);
  }, [stage]);
  return elapsedMs;
}
