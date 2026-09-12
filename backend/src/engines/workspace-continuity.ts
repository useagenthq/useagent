import { and, desc, eq, gt, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/client";
import { providerEvents, runs } from "../db/schema";
import { recordProviderEvent } from "../runs/provider-events";
import type { EngineRunContext } from "./types";

// ---------------------------------------------------------------------------
// A thread's sandbox is its world (workspace, tools, resident processes). When
// that sandbox is gone by the time a follow-up arrives (reclaimed under
// capacity pressure, expired at the provider, released), the next turn must say
// so in the timeline and tell the agent, instead of silently starting from an
// empty box and letting the agent report "the file no longer exists".
// ---------------------------------------------------------------------------

/** The native `eventType` recorded when the fleet reclaims an idle retained sandbox. */
export const SANDBOX_RECLAIMED = "sandbox.reclaimed";

export interface SandboxReclaimedPayload {
  readonly sandboxId: string;
  readonly reason: "capacity";
}

/** Durable note that the fleet took a thread's idle sandbox to make room. */
export async function recordSandboxReclaimed(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
}): Promise<void> {
  await recordProviderEvent({
    id: `sandboxreclaimed_${input.runId}_${input.sandboxId}`,
    runId: input.runId,
    threadId: input.threadId,
    provider: "skynet",
    eventType: SANDBOX_RECLAIMED,
    payload: { sandboxId: input.sandboxId, reason: "capacity" } satisfies SandboxReclaimedPayload,
  });
}

export interface LostWorkspace {
  /** Timeline step label. */
  readonly label: string;
  /** Turn-context block so the agent knows the earlier files are gone. */
  readonly note: string;
}

const RECLAIMED_LABEL =
  "Workspace was reclaimed while idle; starting a fresh sandbox, earlier files are gone";
const GONE_LABEL =
  "Earlier workspace is no longer available; starting a fresh sandbox, earlier files are gone";

function workspaceNote(reason: string): string {
  return "<workspace_notice>\n" +
    `The sandbox this thread used in earlier turns is gone (${reason}). This turn runs in a fresh ` +
    "sandbox: files, installed tools and running processes from earlier turns no longer exist. " +
    "Recreate what you need before relying on it, and tell the user when they expect earlier files.\n" +
    "</workspace_notice>\n\n";
}

/**
 * Whether this thread ran on a sandbox before and that sandbox is gone. Release
 * paths null `runs.sandbox_id` but keep `sandbox_provider`, which is the durable
 * trace that a workspace once existed. A reclaim marker newer than the last
 * provisioned sandbox names the reason precisely; otherwise the workspace is
 * reported as no longer available.
 */
export async function describeLostWorkspace(
  threadId: string,
  currentRunId: string,
): Promise<LostWorkspace | null> {
  const earlierWithSandbox = and(
    eq(runs.threadId, threadId),
    ne(runs.id, currentRunId),
    isNotNull(runs.sandboxProvider),
  );
  const [earlier] = await db.select({ id: runs.id }).from(runs).where(earlierWithSandbox).limit(1);
  if (!earlier) return null;
  const [reclaim] = await db
    .select({ createdAt: providerEvents.createdAt })
    .from(providerEvents)
    .where(and(eq(providerEvents.threadId, threadId), eq(providerEvents.eventType, SANDBOX_RECLAIMED)))
    .orderBy(desc(providerEvents.createdAt))
    .limit(1);
  if (reclaim) {
    const [provisionedSince] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(earlierWithSandbox, gt(runs.createdAt, reclaim.createdAt)))
      .limit(1);
    if (!provisionedSince) {
      return { label: RECLAIMED_LABEL, note: workspaceNote("reclaimed while idle to make room for other work") };
    }
  }
  return { label: GONE_LABEL, note: workspaceNote("released or expired while idle") };
}

/**
 * Emit the timeline step and extend the turn context when a fresh sandbox
 * replaces one the thread had before. Returns whether a workspace was lost. A
 * lookup failure never blocks provisioning.
 */
export async function noteLostWorkspace(
  ctx: EngineRunContext,
  describe: typeof describeLostWorkspace = describeLostWorkspace,
): Promise<boolean> {
  if (!ctx.threadId) return false;
  const lost = await describe(ctx.threadId, ctx.runId).catch(() => null);
  if (!lost) return false;
  await ctx.emit({ kind: "task", label: lost.label, chip: "warning" });
  ctx.turnContext = `${ctx.turnContext}${lost.note}`;
  return true;
}
