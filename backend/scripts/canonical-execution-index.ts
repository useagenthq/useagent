import {
  applyCanonicalExecutionTranscriptIndex,
  dropCanonicalExecutionTranscriptIndex,
  verifyCanonicalExecutionTranscriptIndex,
} from "../src/db/online-indexes/canonical-execution-transcript";

export async function runCanonicalExecutionIndexCli(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const [command, ...extra] = args;
  if (extra.length > 0 || !command || !["apply", "verify", "drop"].includes(command)) {
    throw new Error("usage: bun run scripts/canonical-execution-index.ts <apply|verify|drop>");
  }
  if (command === "apply") {
    const state = await applyCanonicalExecutionTranscriptIndex();
    console.log(`[canonical-execution-index] ready (${state.kind})`);
    return;
  }
  if (command === "verify") {
    await verifyCanonicalExecutionTranscriptIndex();
    console.log("[canonical-execution-index] verified");
    return;
  }
  await dropCanonicalExecutionTranscriptIndex();
  console.log("[canonical-execution-index] dropped");
}

if (import.meta.main) await runCanonicalExecutionIndexCli();
