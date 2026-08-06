"use client";

import type { OrbState } from "@/components/base/thinking-orb";
import { OrbPill } from "@/components/chat/orb-pill";
import { engineLabel, type EngineId, type RunStatus } from "@/components/chat/types";

/**
 * Boot-phase indicator for the session view. Shown only while a run is queued or
 * running-but-pre-first-step — the engine is spinning up and no activity has
 * streamed in yet. Rendered as an OrbPill so the boot phase reads with the same
 * orb vocabulary as the live working pill; it clears the moment the first step
 * arrives and the Thinking disclosure takes over (a distinct role).
 *
 * State mapping: Daytona boots by provisioning a cloud sandbox → "shaping";
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

  return (
    <OrbPill
      state={state}
      label={label}
      ariaLabel={`${label} - ${engineLabel(engine)}`}
    />
  );
}
