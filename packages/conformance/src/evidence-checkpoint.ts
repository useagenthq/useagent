import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ConformanceCheckpoint {
  readonly complete: boolean;
  readonly expectedTotal: number;
  readonly passed: number;
  readonly provider: string;
  readonly results: readonly unknown[];
  readonly snapshot: string;
  readonly total: number;
}

export async function writeConformanceCheckpoint(
  outputFile: string,
  checkpoint: ConformanceCheckpoint,
): Promise<void> {
  await mkdir(dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, outputFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
