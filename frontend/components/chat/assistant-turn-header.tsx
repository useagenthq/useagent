import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import { type EngineId, engineLabel } from "./types";

/** Who answers in a named agent thread. */
export interface AssistantIdentity {
  readonly name: string;
  readonly avatar: React.ReactNode;
}

/** The assistant identity row shared by conversations and lab samples. */
export function AssistantTurnHeader({
  engine,
  identity,
}: {
  engine: EngineId;
  identity?: AssistantIdentity;
}) {
  return (
    <div className="flex items-center gap-2">
      {identity?.avatar ?? (
        <span className="ring-border-button-default bg-background-secondary-default flex size-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset">
          <OrbitKnotMark className="size-3.5" stroke={2.2} />
        </span>
      )}
      <span className="text-body-2-medium text-text-primary">{identity?.name ?? "Agent"}</span>
      <span className="text-mono-label text-text-tertiary">{engineLabel(engine)}</span>
    </div>
  );
}
