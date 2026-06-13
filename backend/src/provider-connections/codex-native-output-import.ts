import { join } from "node:path";
import { MAX_ARTIFACT_BYTES, publishTrustedArtifact } from "../artifacts/publish";
import { readTrustedImageOutput } from "../artifacts/trusted-output";
import {
  openFinishedWorkObligation,
  recordFinishedWorkReceipt,
  resolveFinishedWorkObligation,
} from "../runs/finished-work-repo";
import { withFinishedWorkRunSerialization } from "../runs/finished-work-lock";
import { finishedWorkRolloutMode } from "../runs/finished-work-rollout";
import type { CodexNativeImageCandidate } from "./codex-native-output";

interface CodexNativeOutputImportInput {
  readonly orgId: string;
  readonly userId: string;
  readonly productThreadId: string;
  readonly runId: string;
  readonly codexHome: string;
  readonly candidate: CodexNativeImageCandidate;
  readonly validateIdentity: (input: {
    readonly threadId: string;
    readonly turnId: string;
  }) => Promise<void>;
}

type ImportHookStage = "after_obligation" | "before_receipt";
type ImportHook = (stage: ImportHookStage) => void | Promise<void>;
type ReceiptRecorder = typeof recordFinishedWorkReceipt;

let importHookForTest: ImportHook | null = null;
let receiptRecorder: ReceiptRecorder = recordFinishedWorkReceipt;

export function setCodexNativeOutputImportHookForTest(hook: ImportHook | null): void {
  importHookForTest = hook;
}

export function setCodexNativeOutputReceiptRecorderForTest(
  recorder: ReceiptRecorder | null,
): void {
  receiptRecorder = recorder ?? recordFinishedWorkReceipt;
}

function permanentFailureCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  return PERMANENT_OUTPUT_FAILURE_CODES.has(message) ? message : null;
}

const PERMANENT_OUTPUT_FAILURE_CODES = new Set([
  "output_content_type_not_allowed",
  "output_empty",
  "output_hardlink_not_allowed",
  "output_not_regular_file",
  "output_path_changed",
  "output_path_invalid",
  "output_path_outside_root",
  "output_path_unavailable",
  "output_symlink_not_allowed",
  "output_too_large",
]);

/** Import one completed Codex image before its sanitized completion frame is
 * forwarded. Filesystem locators stay inside this host-only boundary. */
export async function importCodexNativeOutput(
  input: CodexNativeOutputImportInput,
  source: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (finishedWorkRolloutMode(source) === "off") return;

  try {
    await input.validateIdentity({
      threadId: input.candidate.threadId,
      turnId: input.candidate.turnId,
    });
  } catch {
    // Claimed ids are not authority. Keep the sanitized provider transcript
    // coherent, but never open work or read a file for an unbound candidate.
    return;
  }

  await withFinishedWorkRunSerialization(
    input.runId,
    input.candidate.sourceKey,
    async () => {
      const obligation = await openFinishedWorkObligation({
        orgId: input.orgId,
        runId: input.runId,
        sourceKind: "provider_native",
        authority: "provider_adapter",
        sourceKey: input.candidate.sourceKey,
        requirement: "artifact_create",
        sourceProvider: "codex",
        sourceCallId: input.candidate.sourceKey,
      });
      if (obligation.row.state !== "open") return;
      await importHookForTest?.("after_obligation");

      try {
        const output = await readTrustedImageOutput({
          kind: "isolated_host_output",
          root: join(input.codexHome, "generated_images"),
          path: input.candidate.savedPath,
        }, MAX_ARTIFACT_BYTES);
        const published = await publishTrustedArtifact({
          orgId: input.orgId,
          userId: input.userId,
          runId: input.runId,
          threadId: input.productThreadId,
          provider: "codex",
          sourceKey: input.candidate.sourceKey,
          output,
        });
        await importHookForTest?.("before_receipt");
        await receiptRecorder({
          orgId: input.orgId,
          runId: input.runId,
          obligationId: obligation.row.id,
          kind: "artifact_created",
          authority: "artifact_store",
          sourceKey: input.candidate.sourceKey,
          artifactId: published.record.id,
          metadata: {
            digest: published.record.sha256,
            mime: published.record.contentType,
            byteCount: published.record.sizeBytes,
            provider: "codex",
          },
        });
      } catch (error) {
        const failureCode = permanentFailureCode(error);
        if (!failureCode) return;
        try {
          await resolveFinishedWorkObligation({
            orgId: input.orgId,
            runId: input.runId,
            obligationId: obligation.row.id,
            state: "failed",
            failureCode,
          });
        } catch {
          // A failed resolution remains open and retryable. Never replace the
          // trusted reader's safe code with a guessed database/invariant code.
        }
      }
    },
  );
}
