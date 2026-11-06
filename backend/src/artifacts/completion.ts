import { createHash } from "node:crypto";
import { posix } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, type DbTx } from "../db/client";
import { sqlStateOf } from "../db/pg-errors";
import { artifacts, finishedWorkObligations, runs } from "../db/schema";
import { hasRunCancelIntent } from "../commands/cancel";
import { absoluteArtifactPreviewUrl, absoluteArtifactUrl } from "../knowledge/gateway/artifact-links";
import { withFinishedWorkMaterializer } from "../runs/finished-work-materialization-context";
import { lockFinishedWorkRun } from "../runs/finished-work-lock";
import { openFinishedWorkObligation, recordFinishedWorkMaterialization, recordFinishedWorkReceipt, resolveFinishedWorkObligation } from "../runs/finished-work-repo";
import { resolveAttachedSandboxWorkspaceRoot } from "../sandboxes/workspace";
import { discoverTurnOutputs, sandboxStillAnswers, TurnOutputListingUnavailable, type TurnOutputDiscovery } from "./harvest";
import { publishSandboxArtifact } from "./publish";
import { getArtifactForOrg, type ArtifactDescriptor } from "./repo";
import { explicitOutputLinks, replaceOutputLinks } from "./output-links";

type Run = typeof runs.$inferSelect;
export const ARTIFACT_COMPLETION_FAILURE =
  "Artifact delivery failed: an output could not be published. The task is not complete. Retry the task or inspect its artifact details.";
/** Said when automatic discovery left changed files out, so a summary never
 *  implies every file the turn made was delivered. */
export const WITHHELD_OUTPUTS_NOTE =
  "\n\nOther files this turn changed were not delivered automatically (more than 20, empty, or over 50 MB). " +
  "Ask for the ones you need.";
/** Said when the sandbox would not list the turn's files even after retries
 *  but still answers. The answer and every file the agent linked still
 *  deliver; only automatic discovery is skipped, so the run finishes. */
export const UNCOLLECTED_OUTPUTS_NOTE =
  "\n\nFiles this turn changed could not be collected automatically. Ask for the ones you need.";
const OUTPUT_BUDGET_MS = 90_000;
const MAX_OUTPUTS = 20;

export interface ArtifactCompletionOptions {
  readonly signal?: AbortSignal;
  readonly requiresClaim?: boolean;
  /** Non-mutating recovery fence; rechecked in every publication transaction. */
  readonly publicationClaim?: (tx: DbTx) => Promise<boolean>;
}

class LostPublicationClaim extends Error {}

function outputGuard(run: Run, options: ArtifactCompletionOptions, signal: AbortSignal) {
  return async (tx: DbTx): Promise<void> => {
    signal.throwIfAborted();
    await tx.execute(sql`select set_config('lock_timeout', '10000', true), set_config('statement_timeout', '10000', true)`);
    await lockFinishedWorkRun(run.id, tx);
    if (options.requiresClaim && (!options.publicationClaim || !await options.publicationClaim(tx))) {
      throw new LostPublicationClaim();
    }
    const [current] = await tx.select().from(runs)
      .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId!))).for("update").limit(1);
    if (!current || !["queued", "running"].includes(current.status)
      || current.threadId !== run.threadId || current.sandboxId !== run.sandboxId
      || current.sandboxProvider !== run.sandboxProvider
      || JSON.stringify(current.expectedSandbox) !== JSON.stringify(run.expectedSandbox)) {
      throw new LostPublicationClaim();
    }
    if (await hasRunCancelIntent(run.orgId!, run.id, tx)) {
      throw new DOMException("Run stopped", "AbortError");
    }
    signal.throwIfAborted();
  };
}

/** The error's kind, SQLSTATE and sandbox RPC code only: its message can
 *  carry query parameters with file contents. */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const rpcCode = /^(\d+): /.exec(error.message)?.[1];
  return [error.name, sqlStateOf(error), rpcCode && `rpc ${rpcCode}`].filter(Boolean).join(" ");
}

function fileLinks(files: readonly ArtifactDescriptor[]): string {
  if (files.length === 0) return "";
  return "\n\nFiles:\n" + files.map((file) =>
    `- [${file.name.replace(/[\\[\]]/g, "\\$&")}](${absoluteArtifactPreviewUrl(file)})`
  ).join("\n");
}

/** Discovery and sandbox reads occur outside the finalization transaction.
 * Every publication rechecks ownership/cancel in its own short commit; the
 * materializer writes its receipt atomically with the artifact reference. */
export async function completeRunOutputs(
  run: Run,
  summary: string,
  options: ArtifactCompletionOptions = {},
): Promise<{ status: "completed" | "failed" | "obsolete"; summary: string; artifactIds: string[] }> {
  if (!run.orgId) return { status: "completed", summary, artifactIds: [] };
  const signal = AbortSignal.any([
    AbortSignal.timeout(OUTPUT_BUDGET_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  const guard = outputGuard(run, options, signal);
  const delivered: ArtifactDescriptor[] = [];
  try {
    await db.transaction(guard);
    // A legacy text-only recovery needs no sandbox credentials. Resolve the
    // attached root only when rendered local links actually need publication.
    let links = explicitOutputLinks(summary, "/");
    if (!run.sandboxId) {
      if (links.length > 0) throw new Error("output has no attached sandbox");
      return { status: "completed", summary, artifactIds: [] };
    }
    if (links.length > 0) {
      const root = await resolveAttachedSandboxWorkspaceRoot(run as Run & { sandboxId: string });
      links = explicitOutputLinks(summary, root);
    }
    const explicitPaths = new Set(links.map((link) => link.path));
    // Linked outputs are required and count first; automatic ones fill what is left.
    if (explicitPaths.size > MAX_OUTPUTS) throw new Error("too many outputs");
    let discovery: TurnOutputDiscovery = { candidates: [], withheldPaths: [], truncated: false };
    let uncollected = false;
    try {
      discovery = await discoverTurnOutputs(run, { signal });
    } catch (error) {
      // Only a dropped listing against a sandbox that is still bound and still
      // answers is skipped. A wrong listing, a changed binding or a sandbox
      // that is gone fails delivery as before.
      if (!(error instanceof TurnOutputListingUnavailable) || signal.aborted) throw error;
      await db.transaction(guard);
      if (!await sandboxStillAnswers(run, signal)) throw error;
      console.warn(`[artifacts] run ${run.id} output discovery failed:`, errorKind(error.cause));
      uncollected = true;
    }
    const automaticPaths = discovery.candidates.map((file) => file.path).filter((path) => !explicitPaths.has(path));
    const room = MAX_OUTPUTS - explicitPaths.size;
    const paths = [...explicitPaths, ...automaticPaths.slice(0, room)];
    // Left out: past the cap, or empty/oversized files nobody linked (a linked
    // one is published or fails the run below).
    const withheld = discovery.truncated || automaticPaths.length > room ||
      discovery.withheldPaths.some((path) => !explicitPaths.has(path));
    const urls = new Map<string, { preview: string; download: string }>();
    for (const path of paths) {
      signal.throwIfAborted();
      const [known] = await db.select().from(artifacts).where(and(
        eq(artifacts.orgId, run.orgId), eq(artifacts.threadId, run.threadId), eq(artifacts.sourcePath, path),
      )).orderBy(desc(artifacts.createdAt), desc(artifacts.workpieceRevision)).limit(1);
      const sourceKey = `turn-output:${createHash("sha256").update(run.id).update("\0").update(path).digest("hex")}`;
      const { row: obligation } = await db.transaction(async (tx) => {
        await guard(tx);
        const [prior] = await tx.select().from(finishedWorkObligations).where(and(
          eq(finishedWorkObligations.orgId, run.orgId!), eq(finishedWorkObligations.threadId, run.threadId),
          eq(finishedWorkObligations.runId, run.id), eq(finishedWorkObligations.sourceKey, sourceKey),
        )).limit(1);
        if (prior) return { row: prior, created: false };
        const targetArtifactId = known?.id;
        return openFinishedWorkObligation({
          orgId: run.orgId!, runId: run.id, sourceKind: "sandbox_output",
          authority: "integration_gateway", sourceKey, sourceProvider: run.engine,
          requirement: targetArtifactId ? "artifact_update" : "artifact_create",
          ...(targetArtifactId ? { targetArtifactId } : {}),
          candidateName: posix.basename(path).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 180),
        }, tx);
      });
      try {
        const published = await withFinishedWorkMaterializer(async (materialized, tx) => {
          const record = await getArtifactForOrg(run.orgId!, materialized.id, tx);
          if (!record) throw new Error("published artifact missing");
          await recordFinishedWorkMaterialization({
            orgId: run.orgId!, runId: run.id, obligationId: obligation.id,
            artifactId: record.id, artifactRevision: record.workpieceRevision,
          }, tx);
          await recordFinishedWorkReceipt({
            orgId: run.orgId!, runId: run.id, obligationId: obligation.id, sourceKey,
            kind: obligation.requirement === "artifact_update" ? "artifact_updated" : "artifact_created", authority: "artifact_store",
            artifactId: record.id, artifactRevision: record.workpieceRevision,
            metadata: { digest: record.sha256, mime: record.contentType.split(";", 1)[0]!, byteCount: record.sizeBytes },
          }, tx);
        }, () => publishSandboxArtifact({
          orgId: run.orgId!, userId: run.userId, runId: run.id, threadId: run.threadId,
          path, purpose: "deliverable", ...(obligation.targetArtifactId ? { updatesArtifactId: obligation.targetArtifactId } : {}),
        }, { signal, beforeCommit: guard, skipUnchangedRevision: true }));
        signal.throwIfAborted();
        urls.set(path, {
          preview: absoluteArtifactUrl(published.artifact.preview_url),
          download: absoluteArtifactUrl(published.artifact.download_url),
        });
        if (explicitPaths.has(path) || !known || known.sha256 !== published.record.sha256) {
          delivered.push(published.artifact);
        }
      } catch (error) {
        if (error instanceof LostPublicationClaim) throw error;
        if (!signal.aborted) await db.transaction(async (tx) => {
          await guard(tx);
          await resolveFinishedWorkObligation({
            orgId: run.orgId!, runId: run.id, obligationId: obligation.id,
            state: "failed", failureCode: "output_publication_failed",
          }, tx);
        });
        throw error;
      }
    }
    const automatic = delivered.filter((file) => !explicitPaths.has(file.source_path));
    return {
      status: "completed",
      summary: replaceOutputLinks(summary, links, urls) + fileLinks(automatic) + (withheld ? WITHHELD_OUTPUTS_NOTE : "") +
        (uncollected ? UNCOLLECTED_OUTPUTS_NOTE : ""),
      artifactIds: [...new Set(delivered.map((file) => file.id))],
    };
  } catch (error) {
    if (!(error instanceof LostPublicationClaim)) {
      console.warn(`[artifacts] run ${run.id} output delivery failed:`, errorKind(error));
    }
    return {
      status: error instanceof LostPublicationClaim ? "obsolete" : "failed",
      summary: ARTIFACT_COMPLETION_FAILURE + fileLinks(delivered),
      artifactIds: [...new Set(delivered.map((file) => file.id))],
    };
  }
}
