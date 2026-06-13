import { AsyncLocalStorage } from "node:async_hooks";
import type { Executor } from "../db/client";

interface FinishedWorkMaterializedArtifact {
  readonly id: string;
  readonly workpieceRevision: number;
}

type FinishedWorkMaterializer = (
  artifact: FinishedWorkMaterializedArtifact,
  exec: Executor,
) => Promise<void>;

const materializerStorage = new AsyncLocalStorage<FinishedWorkMaterializer>();

export function withFinishedWorkMaterializer<T>(
  materializer: FinishedWorkMaterializer,
  operation: () => Promise<T>,
): Promise<T> {
  return materializerStorage.run(materializer, operation);
}

export async function materializeFinishedWorkArtifactIfActive(
  artifact: FinishedWorkMaterializedArtifact,
  exec: Executor,
): Promise<void> {
  const materializer = materializerStorage.getStore();
  if (materializer) await materializer(artifact, exec);
}
