import { desc, eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";
import {
  acceptInternalRunCommand,
  acceptRunCommand,
  acceptUnattendedRunCommand,
  preflightInternalRunCommandReplay,
  preflightRunCommandReplay,
  preflightUnattendedRunCommandReplay,
  StaleThreadHeadError,
} from "../commands/service";
import type { RunCommandIntent, RunCommandOutcome } from "../commands/types";
import { getThreadRelationship } from "./thread-relationship-repo";
import { isInternalRunOrigin, isUnattendedRunOrigin, type UnattendedRunOrigin } from "./origin";
import { legacyParentResources, resolveRunIntake } from "../resources/run-intake";
import { createRunResourceAuthorization } from "../resources/authorization";
import type { RunCommandInput } from "../commands/types";
import { findCommandByKey } from "../commands/repo";

export async function acceptResolvedThreadFollowup(input: {
  readonly orgId: string;
  readonly expectedParentRunId: string;
  readonly command: RunCommandInput;
  readonly requireRelationship: boolean;
  readonly requireCurrentHead: boolean;
  readonly origin?: UnattendedRunOrigin;
}): Promise<RunCommandOutcome | { readonly status: "not_found" } | { readonly status: "stale_parent" }> {
  if (input.requireRelationship && !await getThreadRelationship(input.orgId, input.command.run.threadId)) {
    return { status: "not_found" };
  }
  const [parent] = await db.select({
    id: runs.id,
    origin: runs.origin,
    engine: runs.engine,
    model: runs.model,
  }).from(runs).where(and(
    eq(runs.orgId, input.orgId),
    eq(runs.threadId, input.command.run.threadId),
    eq(runs.id, input.expectedParentRunId),
  )).limit(1);
  if (!parent) return { status: "not_found" };
  if (input.requireCurrentHead) {
    const [latest] = await db.select({ id: runs.id }).from(runs).where(and(
      eq(runs.orgId, input.orgId), eq(runs.threadId, input.command.run.threadId),
    )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
    if (latest?.id !== input.expectedParentRunId) return { status: "stale_parent" };
  }
  const inheritsParentModel =
    input.command.run.engine === parent.engine && input.command.run.model === parent.model;
  const authorizedCommand = inheritsParentModel
    ? { ...input.command, acceptedModelPolicy: "persisted" as const }
    : input.command;
  const command = input.requireCurrentHead
    ? { ...authorizedCommand, expectedThreadHeadRunId: input.expectedParentRunId }
    : authorizedCommand;
  try {
    if (input.origin) {
      return await acceptUnattendedRunCommand({ ...command, origin: input.origin });
    }
    if (isInternalRunOrigin(parent.origin)) {
      return await acceptInternalRunCommand({ ...command, origin: parent.origin });
    }
    if (isUnattendedRunOrigin(parent.origin)) {
      return await acceptUnattendedRunCommand({ ...command, origin: parent.origin });
    }
    return await acceptRunCommand(command);
  } catch (error) {
    if (error instanceof StaleThreadHeadError) return { status: "stale_parent" };
    throw error;
  }
}

export class ThreadFollowupTargetError extends Error {
  constructor(readonly code: "parent_run_not_found" | "stale_parent_run", readonly status: 404 | 409) {
    super(code);
  }
}

export async function acceptExistingThreadFollowup(
  orgId: string,
  parentRunId: string,
  command: RunCommandInput,
  origin?: UnattendedRunOrigin,
): Promise<RunCommandOutcome> {
  const outcome = await acceptResolvedThreadFollowup({
    orgId,
    expectedParentRunId: parentRunId,
    command,
    requireRelationship: false,
    requireCurrentHead: false,
    origin,
  });
  if (outcome.status === "not_found") throw new ThreadFollowupTargetError("parent_run_not_found", 404);
  if (outcome.status === "stale_parent") throw new ThreadFollowupTargetError("stale_parent_run", 409);
  return outcome;
}

export async function acceptThreadFollowup(input: {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly threadId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly idempotencyKey: string;
}): Promise<RunCommandOutcome | { readonly status: "not_found" } | { readonly status: "stale_parent" } | { readonly status: "attachments_require_actor" }> {
  const relationship = await getThreadRelationship(input.orgId, input.threadId);
  if (!relationship) return { status: "not_found" };
  if (!input.actorId && input.attachmentIds.length > 0) return { status: "attachments_require_actor" };
  const text = input.text.trim();
  if (!text) throw new Error("follow-up text is required");
  const existing = await findCommandByKey(input.orgId, input.idempotencyKey);
  if (existing) {
    if (existing.threadId !== input.threadId || !existing.runId) return { status: "conflict", reason: "payload_mismatch" };
    const existingRun = await db.select().from(runs).where(and(
      eq(runs.orgId, input.orgId),
      eq(runs.id, existing.runId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!existingRun) return { status: "not_found" };
    const replayIntent: RunCommandIntent = {
      prompt: text,
      model: existingRun.model,
      engine: existingRun.engine,
      parentRunId: existingRun.parentRunId,
      requestedRepos: [],
      requestedResources: [],
      attachmentIds: [...input.attachmentIds],
      memoryScope: existingRun.memoryScope,
      skillId: null,
      skillVersion: null,
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    };
    if (isInternalRunOrigin(existingRun.origin)) {
      return (await preflightInternalRunCommandReplay({
          orgId: input.orgId,
          idempotencyKey: input.idempotencyKey,
          intent: replayIntent,
          origin: existingRun.origin,
        }))!;
    }
    if (isUnattendedRunOrigin(existingRun.origin)) {
      return (await preflightUnattendedRunCommandReplay({
        orgId: input.orgId,
        idempotencyKey: input.idempotencyKey,
        intent: replayIntent,
        origin: existingRun.origin,
      }))!;
    }
    return (await preflightRunCommandReplay({
          orgId: input.orgId,
          idempotencyKey: input.idempotencyKey,
          intent: replayIntent,
        }))!;
  }
  const [latest] = await db.select().from(runs).where(and(
    eq(runs.orgId, input.orgId),
    eq(runs.threadId, input.threadId),
  )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
  if (!latest) return { status: "not_found" };
  const inheritedResources = latest.resolvedResources.length > 0
    ? latest.resolvedResources
    : legacyParentResources(latest.repos, "web");
  const intake = await resolveRunIntake(
    { source: "web", text: "", inheritedResources },
    { authorize: createRunResourceAuthorization(input.orgId) },
  );
  const intent: RunCommandIntent = {
    prompt: text,
    model: latest.model,
    engine: latest.engine,
    parentRunId: latest.id,
    requestedRepos: [],
    requestedResources: [],
    attachmentIds: [...input.attachmentIds],
    memoryScope: latest.memoryScope,
    skillId: null,
    skillVersion: null,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
  const command = {
    idempotencyKey: input.idempotencyKey,
    orgId: input.orgId,
    actorId: input.actorId,
    intent,
    run: {
      id: crypto.randomUUID(),
      prompt: text,
      model: latest.model,
      engine: latest.engine,
      parentRunId: latest.id,
      threadId: input.threadId,
      repos: [...intake.repos],
      resolvedResources: intake.resources,
      attachmentIds: [...input.attachmentIds],
      memoryScope: latest.memoryScope,
      skillId: null,
      skillVersion: null,
      skillContentHash: null,
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    },
  };
  return acceptResolvedThreadFollowup({
    orgId: input.orgId,
    expectedParentRunId: latest.id,
    command,
    requireRelationship: true,
    requireCurrentHead: true,
  });
}
