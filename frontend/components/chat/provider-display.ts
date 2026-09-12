import { toolServerDisplayName } from "@useagent/agent-harness/canonical";

/**
 * Human display label for a tool's provider/server id. New gateway traffic uses
 * `useagent`; historical events may still carry the retired wire id. Both render
 * as the product name while genuine engine providers pass through unchanged.
 * A null provider also passes through unchanged.
 */
export function providerDisplayName(provider: string | null): string | null {
  return provider === null ? null : toolServerDisplayName(provider);
}
