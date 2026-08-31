import { providerSessionBinding } from "@useagent/agent-harness/canonical";
import type { EngineRunContext } from "./engines/types";
import { setRunProviderSession } from "./runs/repo";

/** Persist the complete provider-session authority and keep failures observable
 * for adapters that do not await the durability boundary. */
export function createProviderSessionSaver(
  runId: string,
): NonNullable<EngineRunContext["saveProviderSession"]> {
  return (session, authEpoch = null) => {
    const persistence = setRunProviderSession(
      runId,
      providerSessionBinding(session, authEpoch),
    );
    void persistence.catch((err) =>
      console.error(`[worker] failed to persist provider session for ${runId}:`, err),
    );
    return persistence;
  };
}
