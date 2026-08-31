import type { ProviderSessionBinding } from "@useagent/agent-harness/canonical";
import {
  getCodexSubscriptionRuntimeSelection,
  type CodexSubscriptionRuntimeSelection,
} from "../provider-connections/service";

type CodexEpochResolver = (scope: {
  orgId: string;
  userId: string;
  provider: "openai";
}) => Promise<CodexSubscriptionRuntimeSelection | null>;

/** Revalidate credential-generation authority before out-of-turn control.
 * Null epochs represent gateway-backed sessions with no external credential
 * generation. Non-null epochs are currently emitted only by subscription-backed
 * Codex and must still match the connected account row. */
export async function providerSessionAuthIsCurrent(
  input: {
    readonly binding: ProviderSessionBinding;
    readonly orgId: string | null;
    readonly userId: string | null;
  },
  resolveCodex: CodexEpochResolver = getCodexSubscriptionRuntimeSelection,
): Promise<boolean> {
  if (input.binding.authEpoch === null) return true;
  if (input.binding.provider !== "codex" || !input.orgId || !input.userId) return false;
  const current = await resolveCodex({
    orgId: input.orgId,
    userId: input.userId,
    provider: "openai",
  });
  return current?.authEpoch === input.binding.authEpoch;
}
